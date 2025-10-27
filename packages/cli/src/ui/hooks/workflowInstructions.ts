/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const getWorkflowInstructions = async (
  toolDefinitions: string,
  userQuery: string,
  promptName?: string,
) => {
  const defaultPromptPath = path.join(
    process.cwd(),
    '.gemini',
    'prompts',
    'default.txt',
  );
  const promptPath = promptName
    ? path.join(process.cwd(), '.gemini', 'prompts', `${promptName}.txt`)
    : undefined;

  let promptContent: string | null = null;

  // Try area-specific prompt first if provided
  if (promptPath) {
    try {
      promptContent = await fs.readFile(promptPath, 'utf-8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        // @ts-expect-error - node error code
        (error as never).code === 'ENOENT'
      ) {
        console.warn(
          `Warning: ${promptPath} not found. Falling back to .gemini/prompts/default.txt if available.`,
        );
      } else {
        console.warn(
          `Warning: Failed to read ${promptPath}. Falling back to .gemini/default.txt if available.`,
        );
      }
    }
  }

  // If no area prompt, try the default .gemini/prompts/default.txt
  if (promptContent === null) {
    try {
      promptContent = await fs.readFile(defaultPromptPath, 'utf-8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        // @ts-expect-error - node error code
        (error as never).code === 'ENOENT'
      ) {
        console.warn(
          `Warning: .gemini/prompts/default.txt not found. Using default workflow instructions.`,
        );
      }
    }
  }

  // If still not found, use the hardcoded default
  if (promptContent === null) {
    promptContent = `As an AI assistant, your primary goal is to help users safely and efficiently, adhering strictly to the following instructions and utilizing your available tools.

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
  }

  return `
${promptContent}

Here are the tools at your disposal:
${toolDefinitions}

Now, please address the following request:
${userQuery}

--

Structure of your response (fill in the [placeholder information] with your actual response):
[request analysis: determine if the user is asking you to perform an action or is asking about information; list the tools and information from the conversation which may be relevant and reflect on the information you must discover about the code]
[get_memories if this request needs more context]
['think' tool call pondering the user request and plan: record your thoughts and plan for handling the user request]
[summary of planned actions: provide a brief bullet point list of actions and files which will be edited]
[actions or tool calls, delegate tasks to specialized agents for better results where possible]
[verification of actions or tool calls, including re-reading code produced or files after editing]
[repeat action or tool call and verification until problem is fixed]
[record_memories if you encountered and solved an issue, gained deeper insight into code functionality and/or, or if learned something that will be helpful in the future]
[3 recommended and contextually relevant follow-up actions or questions]

Remember to exclude the [line_number] during your edit/replace tool calls; these do not exist in the original files, only you can see them.
`;
};
