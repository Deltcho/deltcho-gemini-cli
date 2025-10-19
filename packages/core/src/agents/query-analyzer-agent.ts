/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition, AgentInputs } from './types.js';
import { ReadFileTool } from '../tools/read-file.js';
import { GLOB_TOOL_NAME, THINK_TOOL_NAME } from '../tools/tool-names.js';
import { GrepTool } from '../tools/grep.js';
import { z } from 'zod';

const RelevantFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string(),
        lines: z.array(z.number()).optional(),
        reason: z
          .string()
          .describe(
            "A brief explanation of why this file/lines are relevant to the user's query.",
          ),
      }),
    )
    .describe("A list of files relevant to the user's query."),
});

/**
 * An agent that analyzes the user's query and the codebase to identify
 * relevant files.
 */
export const QueryAnalysisAgent: AgentDefinition<typeof RelevantFilesSchema> = {
  name: 'query_analyzer',
  displayName: 'Query Analyzer Agent',
  description:
    "Analyzes the user's intent and the codebase to identify relevant files and understand the user's goal.",
  inputConfig: {
    inputs: {
      query: {
        description: "The user's query.",
        type: 'string',
        required: true,
      },
    },
  },
  outputConfig: {
    outputName: 'relevant_files',
    description: 'A list of relevant files and line numbers as a JSON object.',
    schema: RelevantFilesSchema,
  },
  processOutput: (output) => JSON.stringify(output, null, 2),
  modelConfig: {
    model: 'gemini-2.5-flash',
    temp: 0.2,
    top_p: 1,
    thinkingBudget: 0,
  },
  runConfig: {
    max_time_minutes: 5,
  },
  toolConfig: {
    tools: [ReadFileTool.Name, GLOB_TOOL_NAME, GrepTool.Name, THINK_TOOL_NAME],
  },
  promptConfig: {
    query: (inputs: AgentInputs) =>
      `Analyze the following user query and the provided codebase to identify the most relevant files and lines.\n\nUser Query:\n<query>\n${inputs['query']}\n</query>\n\nYour task is to return a JSON object with a list of relevant files. For each file, include the path, a list of relevant line numbers, and a brief reason for its relevance.`,
    systemPrompt: `You are an AI assistant that specializes in understanding user intent and identifying relevant files within a codebase. Your primary goal is to analyze the user's request, clarify their underlying intent, and pinpoint the most crucial files and code sections that are pertinent to achieving their objective. You must also provide a brief explanation of why each file or set of lines is relevant.\n\nYou have access to the following tools to help you:\n- 'read_file': Reads the content of a file.\n- 'glob': Finds files matching a glob pattern.\n- 'grep': Searches for a pattern in files.\n\nUse these tools to thoroughly explore the codebase, understand the user's intent, and identify the most relevant files and lines for the given user query. When multiple independent tool calls are needed (e.g., reading multiple files or running multiple searches), always execute them in parallel by including all calls in a single response.`,
  },
};
