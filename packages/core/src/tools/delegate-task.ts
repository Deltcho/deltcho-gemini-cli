/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import type { Part } from '@google/genai';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';
import { DEFAULT_GEMINI_MODEL } from '../config/models.js';
import { AgentExecutor } from '../agents/executor.js';
import type { AgentDefinition, AgentInputs } from '../agents/types.js';
import { LSTool } from './ls.js';
import { ReadFileTool } from './read-file.js';
import { GrepTool } from './grep.js';
import { ThinkTool } from './think.js';
import { WRITE_FILE_TOOL_NAME, GLOB_TOOL_NAME } from './tool-names.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { ParallelEditTool } from './parallel-edit.js';
import { EDIT_TOOL_NAME, SHELL_TOOL_NAME } from './tool-names.js';

export interface DelegateTaskParams {
  conversationSummary: string;
  userRequest: string;
  taskName?: string;
}

export interface DelegateTaskResultData {
  taskName: string;
  promptPath: string;
  modifiedFiles: string[];
  summary: string;
}

class DelegateTaskInvocation extends BaseToolInvocation<
  DelegateTaskParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: DelegateTaskParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Delegate task '${this.params.taskName || ''}' based on conversation summary and user request.`;
  }

  private sanitizeTaskName(raw: string): string {
    const base = raw
      .toLowerCase()
      .replace(/[^a-z0-9\- _]/g, ' ')
      .trim()
      .replace(/\s+/g, '-');
    return base || 'task';
  }

  private async generateSpecializedPrompt(
    summary: string,
    request: string,
  ): Promise<string> {
    const cg = await this.config.getContentGenerator();

    const examplePrompt = `
<frontend_aesthetics>
You tend to converge toward generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight. Focus on:

Typography: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics.

Color & Theme: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.

Motion: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. 

Backgrounds: Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.

Avoid generic AI-generated aesthetics:
- Overused font families (Inter, Roboto, Arial, system fonts)
- Clichéd color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character

Interpret creatively and make unexpected choices that feel genuinely designed for the context. Vary between light and dark themes, different fonts, different aesthetics. You still tend to converge on common choices (Space Grotesk, for example) across generations. Avoid this: it is critical that you think outside the box!
</frontend_aesthetics>`;

    const instruction = `You are to produce a single, self-contained SYSTEM PROMPT to specialize an autonomous software agent to execute the user's task end-to-end within this repository using available tools. The prompt must:
- Clearly define the agent's identity and scope.
- Include rigorous rules on tool usage and editing style consistent with this project.
- Include domain-specific sub-prompts when applicable (e.g., include the <frontend_aesthetics> block if the task involves frontend or UI/UX work).
- Emphasize producing high-quality, minimal, idiomatic changes and adding tests when needed.
- End with explicit termination instructions: the agent must call complete_task with a concise summary of changes when done.

Context for prompt design:
[Conversation Summary]
${summary}

[User Request]
${request}

Here is an example prompt if the user request is building UI components:
${examplePrompt}

Return ONLY the final system prompt text for the specialized agent. Do not wrap in markdown.`;

    const res = await cg.generateContent(
      {
        model: DEFAULT_GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: instruction }] }],
        config: { temperature: 0.2, topP: 0.95 },
      },
      'delegate-task-prompt-synthesis',
    );

    const text = res.candidates?.[0]?.content?.parts
      ?.map((p: Part) => (p as { text?: string }).text || '')
      .join('')
      .trim();

    if (!text) {
      throw new Error(
        'Failed to synthesize specialized prompt. Empty response.',
      );
    }
    return text;
  }

  private async writePromptFile(
    taskName: string,
    content: string,
  ): Promise<string> {
    const dir = path.join(process.cwd(), '.gemini', 'task_prompts');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${taskName}.txt`);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private createTaskAgent(systemPrompt: string): AgentDefinition {
    return {
      name: 'task_delegate_agent',
      displayName: 'Task Delegate Agent',
      description:
        'A specialized autonomous agent that performs a delegated task within this repository using available tools.',
      promptConfig: {
        systemPrompt,
        query: (inputs: AgentInputs) =>
          `Task kickoff.\n\nConversation Summary:\n${
            inputs['conversationSummary'] as string
          }\n\nUser Request:\n${inputs['userRequest'] as string}`,
      },
      modelConfig: {
        model: DEFAULT_GEMINI_MODEL,
        temp: 0.2,
        top_p: 0.95,
        thinkingBudget: this.config.getThinkingBudget?.() ?? -1,
      },
      runConfig: {
        max_time_minutes: 10,
        max_turns: 25,
      },
      toolConfig: {
        tools: [
          LSTool.Name,
          ReadFileTool.Name,
          GLOB_TOOL_NAME,
          GrepTool.Name,
          ThinkTool.Name,
          EDIT_TOOL_NAME,
          WRITE_FILE_TOOL_NAME,
          ParallelEditTool.Name,
          WebFetchTool.Name,
          WebSearchTool.Name,
          SHELL_TOOL_NAME,
        ],
      },
      inputConfig: {
        inputs: {
          conversationSummary: {
            description:
              'A concise but comprehensive summary of the prior conversation/context.',
            type: 'string',
            required: true,
          },
          userRequest: {
            description: 'The explicit user request to accomplish now.',
            type: 'string',
            required: true,
          },
        },
      },
    };
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (out: string) => void,
  ): Promise<ToolResult> {
    const { conversationSummary, userRequest } = this.params;
    const taskName =
      (this.params.taskName && this.sanitizeTaskName(this.params.taskName)) ||
      this.sanitizeTaskName(userRequest.slice(0, 60));

    if (updateOutput) updateOutput('Synthesizing specialized task prompt...\n');
    const systemPrompt = await this.generateSpecializedPrompt(
      conversationSummary,
      userRequest,
    );

    const promptPath = await this.writePromptFile(taskName, systemPrompt);

    // Snapshot before
    let beforeHash = '';
    let afterHash = '';
    const git = await this.config.getGitService();
    try {
      beforeHash = await git.createFileSnapshot(
        `[delegate_task:${taskName}] start`,
      );
    } catch {
      // ignore snapshot errors
    }

    // Run the specialized agent
    const agent = this.createTaskAgent(systemPrompt);
    if (updateOutput) updateOutput('Launching specialized agent...\n');

    const executor = await AgentExecutor.create(
      agent,
      this.config,
      (activity) => {
        if (!updateOutput) return;
        if (
          activity.type === 'THOUGHT_CHUNK' &&
          typeof activity.data['text'] === 'string'
        ) {
          updateOutput(`🤖💭 ${activity.data['text']}`);
        }
      },
    );

    const output = await executor.run(
      { conversationSummary, userRequest },
      signal,
    );

    // Snapshot after
    try {
      afterHash = await git.createFileSnapshot(
        `[delegate_task:${taskName}] end`,
      );
    } catch {
      // ignore
    }

    // Try to get changed files between snapshots if possible
    let modifiedFiles: string[] = [];
    try {
      // @ts-expect-error - method added by our patch (optional at runtime)
      if (
        beforeHash &&
        afterHash &&
        typeof git.getChangedFilesBetweenCommits === 'function'
      ) {
        // @ts-expect-error - see above
        modifiedFiles = await git.getChangedFilesBetweenCommits(
          beforeHash,
          afterHash,
        );
      }
    } catch {
      // ignore
    }

    const summary = output.result || 'Task completed.';

    const data: DelegateTaskResultData = {
      taskName,
      promptPath,
      modifiedFiles,
      summary,
    };

    const json = JSON.stringify(data, null, 2);

    return {
      llmContent: [{ text: json }],
      returnDisplay: `Delegate Task Completed\n\nTask: ${taskName}\nPrompt: ${promptPath}\nModified Files: ${modifiedFiles.length}\n\nSummary:\n${summary}\n`,
    };
  }
}

export class DelegateTaskTool extends BaseDeclarativeTool<
  DelegateTaskParams,
  ToolResult
> {
  static readonly Name = 'delegate_task';

  constructor(private readonly config: Config) {
    super(
      DelegateTaskTool.Name,
      'Delegate Task',
      'Creates a specialized prompt for a sub-agent based on the conversation summary and user request, runs the task autonomously, and returns modified files and a summary.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          conversationSummary: {
            type: 'string',
            description:
              'A summary of the prior conversation/context to inform specialization.',
          },
          userRequest: {
            type: 'string',
            description: 'The explicit user request to fulfill.',
          },
          taskName: {
            type: 'string',
            description:
              'Optional short name/slug for the task. If omitted, will be derived from the request.',
          },
        },
        required: ['conversationSummary', 'userRequest'],
      },
    );
  }

  protected createInvocation(
    params: DelegateTaskParams,
  ): ToolInvocation<DelegateTaskParams, ToolResult> {
    return new DelegateTaskInvocation(this.config, params);
  }
}
