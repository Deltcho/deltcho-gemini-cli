/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';
import { RECORD_MEMORIES_TOOL_NAME } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

interface RecordMemoriesParams {
  memoryTrace: string; // 10-15 words concise summary
  memoryCategory: string; // 1-2 words category
  fullMemory: string; // longer description
}

class RecordMemoriesInvocation extends BaseToolInvocation<
  RecordMemoriesParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: RecordMemoriesParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Record memory: ${this.params.memoryCategory} :: ${this.params.memoryTrace?.slice(0, 80) || ''}`;
  }

  private sanitizePart(raw: string, fallback: string): string {
    const trimmed = (raw || '').toLowerCase().trim();
    const cleaned = trimmed.replace(/[^a-z0-9\- _]/g, ' ').replace(/\s+/g, '-');
    return cleaned || fallback;
  }

  private enforceWordLimits(trace: string, category: string): string | null {
    const countWords = (s: string) =>
      s.trim() ? s.trim().split(/\s+/).length : 0;
    const traceWords = countWords(trace);
    const catWords = countWords(category);
    if (traceWords > 0 && (traceWords < 3 || traceWords > 20)) {
      return `memoryTrace should be concise (about 10-15 words). Provided: ~${traceWords} words.`;
    }
    if (catWords > 0 && catWords > 3) {
      return `memoryCategory should be 1-2 words. Provided: ~${catWords} words.`;
    }
    return null;
  }

  async execute(): Promise<ToolResult> {
    const { memoryTrace, memoryCategory, fullMemory } = this.params;

    if (!fullMemory || !fullMemory.trim()) {
      return {
        llmContent: 'Full memory content is required.',
        returnDisplay: 'Full memory content is required.',
        error: { message: 'Missing fullMemory', type: ToolErrorType.UNKNOWN },
      };
    }

    const limitsError = this.enforceWordLimits(
      memoryTrace || '',
      memoryCategory || '',
    );
    if (limitsError) {
      // Non-fatal: return warning but proceed
    }

    const projectRoot = this.config.getProjectRoot();
    const dir = path.join(projectRoot, '.gemini', 'memory');

    const safeCategory = this.sanitizePart(
      memoryCategory || 'general',
      'general',
    );
    const safeTrace = this.sanitizePart(memoryTrace || 'note', 'note');

    const filename = `${safeCategory}-${safeTrace}.txt`;
    const absPath = path.join(dir, filename);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(absPath, fullMemory.trim() + '\n', 'utf8');
    } catch (err) {
      const msg = `Failed to write memory file: ${String(err)}`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg, type: ToolErrorType.UNKNOWN },
      };
    }

    const rel = path.relative(projectRoot, absPath);
    const warning = limitsError ? `\nWarning: ${limitsError}` : '';

    const display = `Memory recorded at ${rel}.${warning}`;
    return {
      llmContent: display,
      returnDisplay: display,
    };
  }
}

export class RecordMemoriesTool extends BaseDeclarativeTool<
  RecordMemoriesParams,
  ToolResult
> {
  static readonly Name: string = RECORD_MEMORIES_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      RecordMemoriesTool.Name,
      'RecordMemories',
      'Records a long-term memory by writing it to ./.gemini/memory/{memoryCategory}-{memoryTrace}.txt. Use for code, interactions, or learnings to remember.',
      Kind.Edit,
      {
        type: 'object',
        properties: {
          memoryTrace: {
            type: 'string',
            description:
              'A concise 10-15 word summary of the memory to help with future retrieval.',
          },
          memoryCategory: {
            type: 'string',
            description: 'A 1-2 word category, e.g., tooling, UI, infra, docs.',
          },
          fullMemory: {
            type: 'string',
            description:
              'The full description of the code, interaction, or learning to remember.',
          },
        },
        required: ['memoryTrace', 'memoryCategory', 'fullMemory'],
      },
    );
  }

  protected createInvocation(
    params: RecordMemoriesParams,
  ): ToolInvocation<RecordMemoriesParams, ToolResult> {
    return new RecordMemoriesInvocation(this.config, params);
  }
}
