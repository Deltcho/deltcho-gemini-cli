/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { makeRelative, shortenPath } from '../utils/paths.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';

import type { PartListUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  GeminiEventType,
  type ToolCallRequestInfo,
  CoreToolScheduler,
  type ToolCall,
} from '../index.js'; // Assuming index.ts exports these
import { ToolErrorType } from './tool-error.js';

/**
 * Parameters for the ParallelEdit tool
 */
export interface ParallelEditToolParams {
  /**
   * The conversation history leading up to the edit.
   */
  conversationHistory: string;

  /**
   * The plan for the code edit.
   */
  plan: string;

  /**
   * The absolute path to the file to edit.
   */
  filePath: string;
}

class ParallelEditToolInvocation extends BaseToolInvocation<
  ParallelEditToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: ParallelEditToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.filePath,
      this.config.getTargetDir(),
    );
    return `Parallel editing ${shortenPath(relativePath)} based on a plan.`;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.filePath }];
  }

  async execute(): Promise<ToolResult> {
    try {
      const { conversationHistory, plan, filePath } = this.params;

      const geminiClient = this.config.getGeminiClient();
      const toolRegistry = this.config.getToolRegistry();

      if (!geminiClient || !toolRegistry) {
        return {
          llmContent: 'Error: Gemini client or Tool Registry not available.',
          returnDisplay: 'Error: Gemini client or Tool Registry not available.',
          error: {
            message: 'Gemini client or Tool Registry not available.',
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      // Read the file content using the read_file tool
      const readFileTool = toolRegistry.getTool('read_file');
      if (!readFileTool) {
        return {
          llmContent: 'Error: read_file tool not found.',
          returnDisplay: 'Error: read_file tool not found.',
          error: {
            message: 'read_file tool not found.',
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }
      const readFileInvocation = readFileTool.build({
        absolute_path: filePath,
      });
      const fileContentResult = await readFileInvocation.execute(
        new AbortController().signal,
      );
      const fileContent =
        typeof fileContentResult.llmContent === 'string'
          ? fileContentResult.llmContent
          : JSON.stringify(fileContentResult.llmContent);

      // Construct the prompt for gemini-2.5-flash
      const prompt: PartListUnion = [
        {
          text: 'You are an expert code editor. Your task is to apply the given plan to the specified file, considering the conversation history. Generate `replace` or `write_file` tool calls to make the necessary changes. Only output tool calls.',
        },
        { text: `Conversation History: ${conversationHistory}` },
        { text: `Plan: ${plan}` },
        {
          text: `File to edit: ${filePath}\nContent:\n\
\
${fileContent}
\

`,
        },
      ];

      const abortController = new AbortController();
      const stream = geminiClient.sendMessageStream(
        prompt,
        abortController.signal,
        'parallel-edit-prompt', // A unique prompt_id for this operation
      );

      const toolCallRequests: ToolCallRequestInfo[] = [];
      for await (const event of stream) {
        if (event.type === GeminiEventType.ToolCallRequest) {
          toolCallRequests.push(event.value);
        }
      }

      if (toolCallRequests.length === 0) {
        return {
          llmContent: `No tool calls generated for file: ${filePath}`,
          returnDisplay: `No tool calls generated for file: ${filePath}`,
        };
      }

      const completedToolCalls: ToolCall[] = [];
      const scheduler = new CoreToolScheduler({
        config: this.config,
        outputUpdateHandler: (toolCallId, outputChunk) => {
          // For now, just log to debug. In a real scenario, this might update UI.
          console.debug(`Tool ${toolCallId} output: ${outputChunk}`);
        },
        onAllToolCallsComplete: async (tools) => {
          completedToolCalls.push(...tools);
        },
        onToolCallsUpdate: (_updatedCoreToolCalls) => {
          // Handle updates if needed
        },
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
      });

      await scheduler.schedule(toolCallRequests, abortController.signal);

      const summaries: string[] = completedToolCalls.map((toolCall) => {
        if (toolCall.status === 'success') {
          return `Successfully applied ${toolCall.request.name} to ${filePath}.`;
        } else if (toolCall.status === 'error') {
          return `Failed to apply ${toolCall.request.name} to ${filePath}: ${toolCall.response.resultDisplay}`;
        }
        return `Tool ${toolCall.request.name} for ${filePath} finished with status: ${toolCall.status}`;
      });

      return {
        llmContent: summaries.join('\n'),
        returnDisplay: summaries.join('\n'),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error in parallel-edit: ${errorMessage}`,
        returnDisplay: `Error in parallel-edit: ${errorMessage}`,
        error: { message: errorMessage, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

/**
 * Implementation of the ParallelEdit tool logic
 */
export class ParallelEditTool extends BaseDeclarativeTool<
  ParallelEditToolParams,
  ToolResult
> {
  static readonly Name: string = 'parallel_edit';

  constructor(private config: Config) {
    super(
      ParallelEditTool.Name,
      'ParallelEdit',
      'Edits a specific file in parallel using gemini-2.5-flash based on conversation history and a plan, generating `replace` or `write_file` tool calls.',
      Kind.Edit, // Assuming it performs write operations
      {
        properties: {
          conversationHistory: {
            description: 'The conversation history leading up to the edit.',
            type: 'string',
          },
          plan: {
            description: 'The plan for the code edit.',
            type: 'string',
          },
          filePath: {
            description: 'The absolute path to the file to edit.',
            type: 'string',
          },
        },
        required: ['conversationHistory', 'plan', 'filePath'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: ParallelEditToolParams,
  ): string | null {
    if (params.filePath.trim() === '') {
      return "The 'filePath' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.filePath)) {
      return `File path must be absolute, but was relative: ${params.filePath}. You must provide an absolute path.`;
    }
    // Additional validation can be added here if needed
    return null;
  }

  protected createInvocation(
    params: ParallelEditToolParams,
  ): ToolInvocation<ParallelEditToolParams, ToolResult> {
    return new ParallelEditToolInvocation(this.config, params);
  }
}
