/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';

/**
 * Parameters for the Think tool
 */
export interface ThinkToolParams {
  /**
   * A thought to think about.
   */
  thought: string;
}

class ThinkToolInvocation extends BaseToolInvocation<
  ThinkToolParams,
  ToolResult
> {
  constructor(params: ThinkToolParams) {
    super(params);
  }

  getDescription(): string {
    return `Thinking: "${this.params.thought.substring(0, 50)}..."`;
  }

  async execute(): Promise<ToolResult> {
    // The 'think' tool is purely for logging the LLM's thought process.
    // It does not perform any external action or obtain new information.
    // The thought is already captured in the invocation log.
    return {
      llmContent: `Thought recorded: "${this.params.thought}"`,
      returnDisplay: `Thought recorded.`,
    };
  }
}

/**
 * Implementation of the Think tool logic
 */
export class ThinkTool extends BaseDeclarativeTool<
  ThinkToolParams,
  ToolResult
> {
  static readonly Name: string = 'think';

  constructor(_config: Config) {
    super(
      ThinkTool.Name,
      'Think',
      'Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.',
      Kind.Think,
      {
        properties: {
          thought: {
            description: 'A thought to think about.',
            type: 'string',
          },
        },
        required: ['thought'],
        type: 'object',
      },
    );
  }

  protected createInvocation(
    params: ThinkToolParams,
  ): ToolInvocation<ThinkToolParams, ToolResult> {
    return new ThinkToolInvocation(params);
  }
}
