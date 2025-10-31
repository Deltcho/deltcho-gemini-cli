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
import { DEFAULT_GEMINI_MODEL, getEffectiveModel } from '../config/models.js';
import { AgentExecutor } from '../agents/executor.js';
import type { AgentDefinition, AgentInputs } from '../agents/types.js';
import { LSTool } from './ls.js';
import { ReadFileTool } from './read-file.js';
import { GrepTool } from './grep.js';
import { ThinkTool } from './think.js';
import { GLOB_TOOL_NAME } from './tool-names.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { z } from 'zod';

export interface DelegateTaskParams {
  conversationSummary: string;
  userRequest: string;
  taskName: string;
}

export interface ProposedChange {
  filePath: string;
  action: 'create' | 'modify' | 'delete';
  content?: string;
  rationale?: string;
}

export interface DelegateTaskResultData {
  taskName: string;
  promptPath: string;
  proposedChanges: ProposedChange[];
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
You are a master UI designer. You can visualize a beautiful and efficient game flow and menu in your mind's eye. You always carefully agonize over every detail and ensure that no mere mortal could find fault in your work before putting it on display.

<frontend_aesthetics>
Stay away from generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight. Focus on:

Typography: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics.

Color & Theme: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.

Motion: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. 

Backgrounds: Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.

Avoid generic AI-generated aesthetics:
- Overused font families (Inter, Roboto, Arial, system fonts)
- Clichéd color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character

Interpret creatively and make unexpected choices that feel genuinely designed for the context. Vary between light and dark themes, different fonts, different aesthetics. It is critical that you think outside the box!
</frontend_aesthetics>`;

    const instruction = `You are to produce a single, self-contained SYSTEM PROMPT to specialize an autonomous expert agent who will perform SOLUTION PLANNING ONLY for the user's task within this repository using available tools.
The specialized agent must NOT modify files or run shell commands. It must only read the codebase and produce a structured proposal of code changes.
The prompt must:

- Clearly define the agent's identity and scope (proposal-only, non-destructive).
- Include domain-specific sub-prompts when applicable (e.g., include the <frontend_aesthetics> block if the task involves frontend or UI/UX work).
- Emphasize producing high-quality, minimal, idiomatic changes and including test file updates when needed in the proposal.
- End with explicit termination instructions: the agent must call 'complete_task' tool with a JSON object matching this schema:
{
  "summary": string,
  "proposedChanges": [
    { "filePath": string, "action": "create"|"modify"|"delete", "content"?: string, "rationale"?: string }
  ]
}

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
        model: getEffectiveModel(
          this.config.isInFallbackMode(),
          this.config.getSubagentModel?.() || DEFAULT_GEMINI_MODEL,
        ),
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

    // Append a small enforcement footer to ensure proposal-only behavior.
    const enforcement = `
---
IMPORTANT: When finished, call complete_task with a JSON 
object {"summary": string, "proposedChanges": Array<...>} as specified above. Do not include additional commentary outside JSON in the final tool call.

Upon completion of your solution planning, you must call the \`complete_task\` tool with a JSON object matching this schema:
{
  "summary": string,
  "proposedChanges": [
    { "filePath": string, "action": "create"|"modify"|"delete", "content"?: string, "rationale"?: string }
  ]
}
`;

    return `${text}\n${enforcement}`;
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

  private createTaskAgent(
    systemPrompt: string,
  ): AgentDefinition<typeof OutputSchema> {
    const OutputSchema = z
      .object({
        summary: z
          .string()
          .describe('Concise summary of the recommended solution and risks.'),
        proposedChanges: z
          .array(
            z.object({
              filePath: z.string(),
              action: z.enum(['create', 'modify', 'delete']),
              content: z.string().optional(),
              rationale: z.string().optional(),
            }),
          )
          .describe(
            'List of proposed code changes. For create/modify, include full file content in "content". For delete, omit content.',
          ),
      })
      .passthrough();

    return {
      name: 'task_delegate_agent',
      displayName: 'Task Delegate Agent',
      description:
        'A specialized autonomous agent that READS the repo and returns a structured proposal of code changes. It does not modify files.',
      promptConfig: {
        systemPrompt,
        query: (inputs: AgentInputs) =>
          `Task kickoff.\n\nConversation Summary:\n${
            inputs['conversationSummary'] as string
          }\n\nUser Request:\n${inputs['userRequest'] as string}`,
      },
      modelConfig: {
        model: getEffectiveModel(
          this.config.isInFallbackMode(),
          this.config.getSubagentModel?.() || DEFAULT_GEMINI_MODEL,
        ),
        temp: 0.2,
        top_p: 0.95,
        thinkingBudget:
          this.config.getSubagentThinkingBudget?.() ??
          this.config.getThinkingBudget?.() ??
          -1,
      },
      runConfig: {
        max_time_minutes: 10,
        max_turns: 100,
      },
      toolConfig: {
        tools: [
          LSTool.Name,
          ReadFileTool.Name,
          GLOB_TOOL_NAME,
          GrepTool.Name,
          ThinkTool.Name,
          WebFetchTool.Name,
          WebSearchTool.Name,
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
      outputConfig: {
        outputName: 'proposal',
        description:
          'Structured plan with summary and list of proposed code changes.',
        schema: OutputSchema,
      },
      processOutput: (output) => JSON.stringify(output, null, 2),
    };
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (out: string) => void,
  ): Promise<ToolResult> {
    const { conversationSummary, userRequest } = this.params;
    const taskName = this.sanitizeTaskName(this.params.taskName);

    if (updateOutput) updateOutput('Synthesizing specialized task prompt...\n');
    const systemPrompt = await this.generateSpecializedPrompt(
      conversationSummary,
      userRequest,
    );

    const promptPath = await this.writePromptFile(taskName, systemPrompt);
    const workflowInstructions = `

Structure of your response (fill in the [placeholder information] with your actual response):
[request analysis: determine if the user is asking you to perform an action or is asking about information; list the tools and information from the conversation which may be relevant and reflect on the information you must discover about the code]
['think' tool call pondering the user request and plan: record your thoughts and plan for handling the user request]
[summary of planned actions: provide a brief bullet point list of actions and files which will be edited]
[actions or tool calls]

Remember to exclude the [line_number] during your edit/replace tool calls; these do not exist in the original files, only you can see them. Always call the 'complete_task' tool whether you have given up or have completed the task fully`;

    const finalSystemPrompt = `${systemPrompt}\n\n ${workflowInstructions}`;

    // Run the specialized agent in PROPOSAL mode (read-only)
    const agent = this.createTaskAgent(finalSystemPrompt);
    if (updateOutput)
      updateOutput('Launching specialized agent (proposal-only)...\n');

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

    // Parse the structured proposal from the subagent
    let summary = 'Task completed.';
    let proposedChanges: ProposedChange[] = [];
    try {
      const parsed = JSON.parse(output.result || '{}');
      if (parsed && typeof parsed === 'object') {
        summary = typeof parsed.summary === 'string' ? parsed.summary : summary;
        if (Array.isArray(parsed.proposedChanges)) {
          proposedChanges = parsed.proposedChanges as ProposedChange[];
        }
      }
    } catch {
      // If parsing fails, keep defaults and include raw text in summary
      summary = output.result || summary;
    }

    const data: DelegateTaskResultData = {
      taskName,
      promptPath,
      proposedChanges,
      summary,
    };

    const json = JSON.stringify(data, null, 2);

    const filesCount = proposedChanges.length;
    return {
      llmContent: [{ text: json }],
      returnDisplay: `Delegate Task Proposal\n\nTask: ${taskName}\nPrompt: ${promptPath}\nProposed Changes: ${filesCount} file(s)\n\nSummary:\n${summary}\n`,
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
      'Creates a specialized prompt for a sub-agent based on the conversation summary and user request, launches a read-only subagent to analyze and propose code changes (without modifying files), and returns the proposed changes plus a summary.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          conversationSummary: {
            type: 'string',
            description:
              'A summary of the prior conversation/context to inform specialization. Only include information relevant for performing the task.',
          },
          userRequest: {
            type: 'string',
            description: 'The explicit user request to fulfill.',
          },
          taskName: {
            type: 'string',
            description: 'Short name/slug for the task.',
          },
        },
        required: ['conversationSummary', 'userRequest', 'taskName'],
      },
    );
  }

  protected createInvocation(
    params: DelegateTaskParams,
  ): ToolInvocation<DelegateTaskParams, ToolResult> {
    return new DelegateTaskInvocation(this.config, params);
  }
}
