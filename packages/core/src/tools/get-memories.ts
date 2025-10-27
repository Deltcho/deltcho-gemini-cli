/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import type {
  FunctionDeclaration,
  Part,
  GenerateContentParameters,
} from '@google/genai';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { GET_MEMORIES_TOOL_NAME } from './tool-names.js';
import { getFunctionCallsFromParts } from '../utils/generateContentResponseUtilities.js';

interface GetMemoriesParams {
  summary: string;
}

class GetMemoriesInvocation extends BaseToolInvocation<
  GetMemoriesParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: GetMemoriesParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Select and return relevant memories for: ${this.params.summary?.slice(0, 120) || ''}`;
  }

  private sanitizeAndNormalizePaths(
    files: string[],
    projectRoot: string,
  ): string[] {
    const normRoot = path.resolve(projectRoot);
    return files
      .map((p) => path.resolve(p))
      .filter((abs) => abs.startsWith(normRoot + path.sep) || abs === normRoot)
      .filter((abs) => abs.endsWith('.txt'));
  }

  private async listMemoryFiles(projectRoot: string): Promise<string[]> {
    const memDir = path.join(projectRoot, '.gemini', 'memory');
    try {
      const entries = await fs.readdir(memDir, { withFileTypes: true });
      const files: string[] = [];
      for (const d of entries) {
        if (d.isFile() && d.name.toLowerCase().endsWith('.txt')) {
          files.push(path.join(memDir, d.name));
        }
      }
      return files;
    } catch {
      return [];
    }
  }

  private buildSelectionFunction(): FunctionDeclaration {
    const schema: FunctionDeclaration = {
      name: 'select_relevant_memories',
      description:
        "Choose the most relevant memory file paths for the user's current request. Return ONLY the list of file paths to read.",
      parametersJsonSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description:
              'An array of absolute file paths (strings) to memory .txt files that should be read and returned.',
            items: { type: 'string' },
          },
        },
        required: ['files'],
      },
    };
    return schema;
  }

  private buildSelectorInstruction(
    summary: string,
    allFiles: string[],
  ): string {
    const relList = allFiles.map((f) => `- ${f}`).join('\n');
    return `You are assisting an agent by pre-selecting relevant long-term memories to load.

Context:
${summary}

Candidate memory files (absolute paths):
${relList || '(no memory files)'}

Think carefully which memories, if any, are relevant to the current user request. Select as few as necessary (often 0-5). If none are relevant, return an empty list.
Use the select_relevant_memories function to return your selection.`;
  }

  private async readFilesAsBlob(
    files: string[],
    projectRoot: string,
  ): Promise<string> {
    const chunks: string[] = [];
    for (const abs of files) {
      try {
        const content = await fs.readFile(abs, 'utf8');
        const rel = path.relative(projectRoot, abs);
        chunks.push(`=== ${rel} ===\n${content.trim()}\n---`);
      } catch {
        // ignore read errors
      }
    }
    return chunks.join('\n');
  }

  async execute(): Promise<ToolResult> {
    const projectRoot = this.config.getProjectRoot();
    const cg = await this.config.getContentGenerator();

    const allFiles = await this.listMemoryFiles(projectRoot);

    if (allFiles.length === 0) {
      const msg = 'No memory files found in ./.gemini/memory';
      return { llmContent: msg, returnDisplay: msg };
    }

    const selectionInstruction = this.buildSelectorInstruction(
      this.params.summary || '',
      allFiles,
    );

    const selectionFn = this.buildSelectionFunction();

    const response = await cg.generateContent(
      {
        model: DEFAULT_GEMINI_FLASH_MODEL,
        contents: [{ role: 'user', parts: [{ text: selectionInstruction }] }],
        config: {
          temperature: 0.2,
          topP: 0.95,
          tools: [{ functionDeclarations: [selectionFn] }],
        },
      } as GenerateContentParameters,
      'get-memories-selection',
    );

    const parts = response.candidates?.[0]?.content?.parts as
      | Part[]
      | undefined;
    const functionCalls = parts ? getFunctionCallsFromParts(parts) : undefined;

    let selected: string[] = [];
    const callPayload = functionCalls?.find(
      (fc) => fc.name === 'select_relevant_memories',
    )?.args as unknown;

    if (
      callPayload &&
      typeof callPayload === 'object' &&
      callPayload !== null
    ) {
      const files = (callPayload as { files?: unknown }).files;
      if (Array.isArray(files)) {
        selected = files.filter((x): x is string => typeof x === 'string');
      }
    }

    if (!selected || selected.length === 0) {
      // Fallback heuristic: choose up to 5 most recent files by mtime
      const stats = await Promise.all(
        allFiles.map(async (f) => ({
          f,
          s: await fs.stat(f).catch(() => null),
        })),
      );
      selected = stats
        .filter((x): x is { f: string; s: Stats } => !!x.s)
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
        .slice(0, 5)
        .map((x) => x.f);
    }

    // Ensure selected paths are within project and are txts
    selected = this.sanitizeAndNormalizePaths(selected, projectRoot);

    const blob = await this.readFilesAsBlob(selected, projectRoot);
    const display = selected.length
      ? `Loaded ${selected.length} memories.\n${blob}`
      : 'No relevant memories selected.';

    return {
      llmContent: blob || 'No relevant memories selected.',
      returnDisplay: display,
    };
  }
}

export class GetMemoriesTool extends BaseDeclarativeTool<
  GetMemoriesParams,
  ToolResult
> {
  static readonly Name: string = GET_MEMORIES_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      GetMemoriesTool.Name,
      'GetMemories',
      'Selects relevant memory files from ./.gemini/memory based on a brief conversation summary, reads them, and returns a concatenated text blob containing each filename and its contents.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              "A brief summary of the conversation relevant to the user's current request, including the user's request.",
          },
        },
        required: ['summary'],
      },
    );
  }

  protected createInvocation(
    params: GetMemoriesParams,
  ): ToolInvocation<GetMemoriesParams, ToolResult> {
    return new GetMemoriesInvocation(this.config, params);
  }
}
