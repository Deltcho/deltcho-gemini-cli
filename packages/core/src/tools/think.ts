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
    return `Thinking: "${this.params.thought}..."`;
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
      "This tool allows you to record your thought process. It should be used to articulate a clear plan of action after analyzing the user's query and code base. The thought should outline the steps the model will take to fulfill the user's request and the relevant files and lines of code that need to be written or modified to address the user's request. Use the tool to think about something, anything, relevant to the user's request or your own problem solving (e.g. user's request, relevant lines, how the code functions, how you might fix the code, etc). It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed. You may also use it to think about your own thoughts (meta-thinking) and self-reflect on why things are not working or how you can improve. This tool does not perform any external action or obtain new information; it is purely for logging the model's thought process.",
      Kind.Think,
      {
        properties: {
          thought: {
            description: 'A thought, problem, or request to think about.',
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
