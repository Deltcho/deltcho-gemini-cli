/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import { HookEventName, createHookOutput } from '../hooks/types.js';
import type { GenerateContentParameters, Part } from '@google/genai';
import { toContents } from '../code_assist/converter.js';

export class WorkflowInstructionsService {
  constructor(
    private readonly config: Config,
    private readonly messageBus: MessageBus,
  ) {
    this.messageBus.subscribe(
      MessageBusType.HOOK_EXECUTION_REQUEST,
      this.handleHookRequest.bind(this),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleHookRequest(message: any) {
    if (
      message.eventName !== HookEventName.BeforeModel ||
      !message.input?.llm_request
    ) {
      return;
    }

    const request = message.input.llm_request as GenerateContentParameters;
    if (!request.contents) {
      return;
    }

    // Normalize contents to Content[]
    const contents = toContents(request.contents);
    if (contents.length === 0) {
      return;
    }

    // Identify the last user message to wrap
    const lastContentIndex = contents.length - 1;
    const lastContent = contents[lastContentIndex];

    if (lastContent.role !== 'user') {
      return;
    }

    // Extract the user query text
    const parts = lastContent.parts || [];
    let userQuery = '';
    const newParts: Part[] = [];

    for (const part of parts) {
      if (part.text) {
        userQuery += part.text;
      } else {
        newParts.push(part);
      }
    }

    userQuery = userQuery.trim();
    if (!userQuery) {
      return;
    }

    // Check for prompt command like /p-frontend
    let selectedPromptName: string | undefined;
    const promptNameMatch = /^\/p-([a-z0-9_-]+)\b/i.exec(userQuery);
    if (promptNameMatch) {
      selectedPromptName = promptNameMatch[1].toLowerCase();
      // Remove the command from the query
      userQuery = userQuery.slice(promptNameMatch[0].length).trimStart();
    }

    const toolDefinitions = JSON.stringify(
      this.config.getToolRegistry().getFunctionDeclarations(),
      null,
      2,
    );

    const promptContent = await this.loadPromptContent(selectedPromptName);
    const wrappedQuery = `
${promptContent}

Here are the tools at your disposal:
${toolDefinitions}

Now, please address the following request:
<user_request>
${userQuery}
</user_request>
`;

    // Reconstruct parts with the wrapped query
    newParts.push({ text: wrappedQuery });

    // Create modified contents array
    const modifiedContents = [...contents];
    modifiedContents[lastContentIndex] = {
      ...lastContent,
      parts: newParts,
    };

    // Respond with modification
    const output = createHookOutput(HookEventName.BeforeModel, {
      hookSpecificOutput: {
        hookEventName: HookEventName.BeforeModel,
        llm_request: {
          contents: modifiedContents,
        },
      },
    });

    this.messageBus.emit(MessageBusType.HOOK_EXECUTION_RESPONSE, {
      type: MessageBusType.HOOK_EXECUTION_RESPONSE,
      correlationId: message.correlationId,
      success: true,
      output,
    });
  }

  private async loadPromptContent(promptName?: string): Promise<string> {
    const projectRoot = this.config.getProjectRoot() || process.cwd();

    // Default fallback prompt
    const defaultHardcoded = `As an AI assistant, your primary goal is to help users safely and efficiently, adhering strictly to the following instructions and utilizing your available tools.

# Core Mandates

- **Conventions:** Rigorously adhere to existing project conventions when reading or modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. Verify its established usage within the project (check imports, configuration files like 'package.json', 'Cargo.toml', 'requirements.txt', 'build.gradle', etc., or observe neighboring files) before employing it.
- **Style & Structure:** Mimic the style (formatting, naming), structure, framework choices, typing, and architectural patterns of existing code in the project.
- **Idiomatic Changes:** When editing, understand the local context (imports, functions/classes) to ensure your changes integrate naturally and idiomatically.
- **Comments:** Add code comments sparingly. Focus on *why* something is done, especially for complex logic, rather than *what* is done. Only add high-value comments if necessary for clarity or if requested by the user. Do not edit comments that are separate from the code you are changing. *NEVER* talk to the user or describe your changes through comments.
- **Proactiveness:** Fulfill the user's request thoroughly. When adding features or fixing bugs, this includes adding tests to ensure quality. Consider all created files, especially tests, to be permanent artifacts unless the user says otherwise.
- **Confirm Ambiguity/Expansion:** Do not take significant actions beyond the clear scope of the request without confirming with the user. If asked *how* to do something, explain first, don't just do it.
- **Explaining Changes:** After completing a code modification or file operation *do not* provide summaries unless asked.
- **Path Construction:** Before using any file system tool (e.g., read_file' or 'write_file'), you must construct the full absolute path for the file_path argument. Always combine the absolute path of the project's root directory with the file's path relative to the root. For example, if the project root is /path/to/project/ and the file is foo/bar/baz.txt, the final path you must use is /path/to/project/foo/bar/baz.txt. If the user provides a relative path, you must resolve it against the root directory to create an absolute path.
- **Do Not revert changes:** Do not revert changes to the codebase unless asked to do so by the user. Only revert changes made by you if they have resulted in an error or if the user has explicitly asked you to revert the changes.

## Task Delegation

- **When to Delegate:** Use the delegate_task tool when the user's request involves significant code changes, feature implementation, or in-depth code analysis that would benefit from a specialized sub-agent.
- **Providing Task Description (userRequest):** When calling delegate_task, ensure the userRequest parameter is a clear, concise, and comprehensive description of the task the delegated agent needs to perform. This should be extracted directly from the user's explicit request.
- **Providing Conversation Summary (conversationSummary):** Always provide a conversationSummary that accurately reflects the current conversation context, including any relevant background information or previous steps.
`;

    // Try specific prompt
    if (promptName) {
      const p = path.join(
        projectRoot,
        '.gemini',
        'prompts',
        `${promptName}.txt`,
      );
      try {
        return await fs.readFile(p, 'utf-8');
      } catch (_e) {
        // ignore
      }
    }

    // Try default file
    const defaultPath = path.join(
      projectRoot,
      '.gemini',
      'prompts',
      'default.txt',
    );
    try {
      return await fs.readFile(defaultPath, 'utf-8');
    } catch (_e) {
      // ignore
    }

    return defaultHardcoded;
  }
}
