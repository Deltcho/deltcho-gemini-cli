/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ToolInvocation } from '../index.js';
import { BaseDeclarativeTool, Kind, type ToolResult } from './tools.js';
import { SubagentInvocation } from '../agents/invocation.js';
import type { AgentDefinition, AgentInputs } from '../agents/types.js';
import { convertInputConfigToJsonSchema } from '../agents/schema-utils.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

export class QueryAnalyzerTool extends BaseDeclarativeTool<
  AgentInputs,
  ToolResult
> {
  private readonly definition: AgentDefinition;
  private readonly config: Config;

  constructor(config: Config, messageBus?: MessageBus) {
    const agentRegistry = config.getAgentRegistry();
    const definition = agentRegistry.getDefinition('query_analyzer');
    if (!definition) {
      throw new Error('QueryAnalyzerAgent not found in registry');
    }

    const parameterSchema = convertInputConfigToJsonSchema(
      definition.inputConfig,
    );

    super(
      definition.name,
      definition.displayName ?? definition.name,
      definition.description,
      Kind.Think,
      parameterSchema,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
      messageBus,
    );

    this.definition = definition;
    this.config = config;
  }

  protected override validateToolParamValues(
    params: AgentInputs,
  ): string | null {
    if (typeof params['query'] !== 'string') {
      return `Invalid parameter: 'query' must be a string, but received type '${typeof params['query']}'.`;
    }
    return null;
  }

  protected override createInvocation(
    params: AgentInputs,
  ): ToolInvocation<AgentInputs, ToolResult> {
    return new SubagentInvocation(
      params,
      this.definition as never,
      this.config,
      this.messageBus,
    );
  }
}
