/**
 * OpenAI-Compatible provider adapter
 * 
 * Generic adapter for any OpenAI-compatible API endpoint:
 * - Ollama (http://localhost:11434/v1)
 * - vLLM
 * - Together AI
 * - Groq
 * - Local inference servers
 * - Any other OpenAI-compatible endpoint
 * 
 * Uses the standard OpenAI chat completions format with tool_calls support.
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  ContentBlock,
  ToolDefinition,
} from '../types/index.js';
import {
  MembraneError,
  rateLimitError,
  contextLengthError,
  authError,
  serverError,
  abortError,
  networkError,
} from '../types/index.js';
import { safeParseJson, textOnlyToolResultContent, createCombinedSignal, SSELineParser, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved } from './utils.js';

// ============================================================================
// Types
// ============================================================================

interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** Reasoning-model trace (OpenRouter et al. deliver this in a separate
   *  channel from `content`). Captured into a thinking block, and re-sent on
   *  prior assistant turns to preserve chain-of-thought. */
  reasoning?: string;
  /** Same trace under the DeepSeek spelling, used e.g. by Xiaomi's official
   *  MiMo API in both messages and stream deltas. Read as an alias of
   *  `reasoning`; `reasoning` wins when a backend sends both. */
  reasoning_content?: string;
  reasoning_details?: unknown;
}

/**
 * The reasoning trace of a message or stream delta, under either spelling.
 * `reasoning` wins unless it is blank while `reasoning_content` has substance —
 * a whitespace-only `reasoning` must not hide the real trace. Whitespace is not
 * trimmed away otherwise: a lone ' ' or '\n' stream delta is part of the trace.
 */
function reasoningOf(m: { reasoning?: unknown; reasoning_content?: unknown } | undefined): string | undefined {
  const reasoning = typeof m?.reasoning === 'string' ? m.reasoning : undefined;
  const alias = typeof m?.reasoning_content === 'string' ? m.reasoning_content : undefined;
  if (reasoning && (reasoning.trim() || !alias?.trim())) return reasoning;
  return alias ?? reasoning;
}

/**
 * Some OpenRouter backends (e.g. Parasail, Io Net) spill the tail of the
 * reasoning plus the closing `</think>` into the `content` channel instead of
 * keeping it all in `reasoning`. If a `</think>` appears with no matching
 * `<think>` before it, drop everything up to and including it — that prefix is
 * leaked reasoning, not answer text.
 */
function stripOrphanThinkClose(text: string): string {
  const close = text.indexOf('</think>');
  if (close === -1) return text;
  const open = text.indexOf('<think>');
  if (open !== -1 && open < close) return text; // well-formed inline block — leave it
  return text.slice(close + '</think>'.length).replace(/^\s+/, '');
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface OpenAICompatibleAdapterConfig {
  /** Base URL for the API (required, e.g., 'http://localhost:11434/v1') */
  baseURL: string;
  
  /** API key (optional for local servers) */
  apiKey?: string;
  
  /** Provider name for logging/identification (default: 'openai-compatible') */
  providerName?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
  
  /** Additional headers to include with requests */
  extraHeaders?: Record<string, string>;
}

// ============================================================================
// OpenAI-Compatible Adapter
// ============================================================================

/**
 * Split a tool_result's content into the string body for the role:'tool'
 * message plus any image blocks hoisted as image_url parts. Chat Completions
 * tool messages are text-only — serializing an image block inline sends the
 * raw base64 as literal text — so images must ride in a user message that
 * follows the tool results. Mirrors openai.ts / openrouter.ts.
 */
function splitToolResultContent(content: unknown): { text: string; imageParts: OpenAIContentPart[] } {
  if (typeof content === 'string') return { text: content, imageParts: [] };
  if (!Array.isArray(content)) return { text: textOnlyToolResultContent(content), imageParts: [] };

  const imageParts: OpenAIContentPart[] = [];
  const rest: any[] = [];
  for (const block of content as any[]) {
    if (block?.type === 'image' && block.source?.type === 'base64' && block.source.data) {
      const mediaType = block.source.media_type ?? block.source.mediaType ?? 'image/png';
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${block.source.data}` },
      });
    } else if (block?.type === 'image' && block.source?.type === 'url') {
      imageParts.push({ type: 'image_url', image_url: { url: block.source.url } });
    } else {
      rest.push(block);
    }
  }
  if (imageParts.length === 0) return { text: textOnlyToolResultContent(content), imageParts };

  const note = `[${imageParts.length === 1 ? 'image' : `${imageParts.length} images`} from this tool result attached in the following user message]`;
  const restText = rest.length === 0
    ? ''
    : rest.every(b => b?.type === 'text') ? rest.map(b => b.text).join('\n') : textOnlyToolResultContent(rest);
  return { text: restText ? `${restText}\n${note}` : note, imageParts };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;

  /**
   * NOT ESTABLISHED, and not establishable per-adapter: this fronts arbitrary
   * OpenAI-shaped third-party endpoints whose caching semantics vary by vendor.
   * Moot today — the adapter never populates `cacheReadTokens`, so the warn
   * never fires; it becomes live the moment cache reporting is added here.
   */
  readonly usageCacheConvention = 'unknown' as const;
  private baseURL: string;
  private apiKey: string;
  private defaultMaxTokens: number;
  private extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleAdapterConfig) {
    if (!config.baseURL) {
      throw new Error('OpenAI-compatible adapter requires baseURL');
    }
    
    this.name = config.providerName ?? 'openai-compatible';
    this.baseURL = config.baseURL.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey ?? '';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  supportsModel(_modelId: string): boolean {
    // This is a generic adapter - it supports whatever the endpoint supports
    // Model routing should be handled at a higher level
    return true;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);
    options?.onRequest?.(openAIRequest);

    try {
      const response = await this.makeRequest(openAIRequest, options);
      return this.parseResponse(response, request.model, openAIRequest);
    } catch (error) {
      throw this.handleError(error, openAIRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);
    openAIRequest.stream = true;
    // OpenAI only emits the final usage chunk for Chat Completions streams
    // when explicitly requested. Without this, live agent calls report zero
    // input/cache tokens even though the usage dashboard records them.
    openAIRequest.stream_options = { include_usage: true };
    options?.onRequest?.(openAIRequest);

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openAIRequest),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      const sseParser = new SSELineParser();
      let accumulated = '';
      let reasoning = '';
      let finishReason = 'stop';
      let sawTerminalEvent = false;
      let toolCalls: OpenAIToolCall[] = [];
      let streamUsage: OpenAIResponse['usage'] | undefined;

      // One frame handler for both the streamed lines and the EOF flush — the
      // trailing buffer carries real terminal frames, not leftovers.
      const processDataLine = (data: string): void => {
        if (data === '[DONE]') {
          sawTerminalEvent = true;
          return;
        }

        // Parse first; only JSON noise is ignorable. Everything after the
        // parse must NOT be swallowed by the catch below.
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // Ignore parse errors (partial/keep-alive lines)
        }

        throwOnStreamErrorFrame(parsed, this.name, openAIRequest);

        try {
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            accumulated += delta.content;
            callbacks.onChunk(delta.content);
          }

          // Reasoning-model trace arrives on its own channel (not `content`),
          // as `reasoning` or `reasoning_content` depending on the backend.
          const reasoningDelta = reasoningOf(delta);
          if (reasoningDelta !== undefined) {
            reasoning += reasoningDelta;
          }

          // Handle streaming tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: tc.id ?? '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
              }
              if (tc.id) toolCalls[index].id = tc.id;
              if (tc.function?.name) toolCalls[index].function.name = tc.function.name;
              if (tc.function?.arguments) {
                toolCalls[index].function.arguments += tc.function.arguments;
              }
            }
          }

          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason;
            sawTerminalEvent = true;
          }

          // Usage rides the final chunk when stream_options.include_usage is set
          if (parsed.usage) {
            streamUsage = parsed.usage;
          }
        } catch {
          // Ignore parse errors in stream
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const data of sseParser.feed(chunk)) {
          processDataLine(data);
        }
      }

      // A final `data:` line that arrived without its trailing newline is still
      // buffered here. Servers and proxies do close right after writing the
      // last event, so dropping it would report a finished turn as a dropped
      // connection at the guard below.
      for (const data of sseParser.flush()) {
        processDataLine(data);
      }

      assertTerminalEventObserved(sawTerminalEvent, this.name, openAIRequest);

      // Build response with accumulated data
      const message: OpenAIMessage = {
        role: 'assistant',
        content: accumulated || null,
      };

      if (reasoning) message.reasoning = reasoning;

      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, request.model, streamUsage, openAIRequest);

    } catch (error) {
      throw this.handleError(error, openAIRequest);
    } finally {
      cleanup?.();
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    
    // Only add Authorization header if we have an API key
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    return headers;
  }

  private buildRequest(request: ProviderRequest): any {
    const messages = this.convertMessages(request.messages as any[]);
    
    // Handle system prompt (same as openrouter.ts)
    if (request.system) {
      if (typeof request.system === 'string') {
        messages.unshift({ role: 'system' as const, content: request.system });
      } else if (Array.isArray(request.system)) {
        const text = (request.system as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        if (text) {
          messages.unshift({ role: 'system' as const, content: text });
        }
      }
    }
    
    // Newer OpenAI models (gpt-5+, o-series) require max_completion_tokens instead of max_tokens
    const completionTokensModels = ['gpt-5', 'o1', 'o3', 'o4'];
    const useCompletionTokens = completionTokensModels.some(prefix => request.model.startsWith(prefix));

    const params: any = {
      model: request.model,
      messages,
      ...(useCompletionTokens
        ? { max_completion_tokens: request.maxTokens || this.defaultMaxTokens }
        : { max_tokens: request.maxTokens || this.defaultMaxTokens }),
    };
    
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      params.top_p = request.topP;
    }

    if (request.presencePenalty !== undefined) {
      params.presence_penalty = request.presencePenalty;
    }

    if (request.frequencyPenalty !== undefined) {
      params.frequency_penalty = request.frequencyPenalty;
    }

    if (request.repetitionPenalty !== undefined) {
      params.repetition_penalty = request.repetitionPenalty;
    }

    // OpenAI-compatible APIs may limit stop sequences (OpenAI: 4) — truncate to be safe
    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop = request.stopSequences.slice(0, 4);
    }
    
    if (request.tools && request.tools.length > 0) {
      params.tools = this.convertTools(request.tools as any[]);
    }
    
    // Earlier OpenAI models accept only "in_memory" or "24h" here. Membrane's
    // 5m/1h values are Anthropic cache-control TTLs and must not leak onto this
    // API. Extended prompt caching is independent of response-object storage.
    if (request.cacheTtl === '24h') {
      params.prompt_cache_retention = '24h';
    }

    // Apply extra params (filter out internal membrane fields + control flags)
    if (request.extra) {
      const { normalizedMessages, prompt, force_think_first, reasoning, ...rest } =
        request.extra as Record<string, unknown>;
      // `reasoning` is a Responses-API / LiteRouter param that OpenAI's direct
      // Chat Completions endpoint rejects ("Unknown parameter: 'reasoning'").
      // Old Chronicle branches may carry it in providerParams from when the
      // agent was created under a compatible proxy; stripping it here keeps
      // those branches usable after switching to OpenAI direct without
      // touching the working LiteRouter config or the 24h cache setup.
      Object.assign(params, rest);

      // Chat Completions spells the effort as a scalar `reasoning_effort`, so
      // translate the stripped `reasoning: {effort}` instead of dropping it
      // (dropping it left gpt-5.1 on its default effort, none). An explicit
      // `reasoning_effort` in extra wins. The agent's reasoning kill switch
      // removes `reasoning` upstream, so disabled still sends nothing.
      const effort = (reasoning as { effort?: unknown } | undefined)?.effort;
      if (typeof effort === 'string' && params.reasoning_effort === undefined) {
        params.reasoning_effort = effort;
      }

      // Round-0 think forcing. `force_think_first` is a control flag (set from
      // the recipe via framework-agent-config), NOT an API param — it is
      // stripped above and never forwarded. When set, force a `think` call on
      // the FIRST round of a turn only: in OpenAI chat format a fresh turn ends
      // with a user message, whereas every resumed tool round ends with
      // tool-result messages — so `role: 'tool'` at the tail means "not round 0"
      // and we leave tool_choice at the provider default (auto). We emit the
      // NAMED form; LiteRouter/gpt-5.1 silently ignores generic "required"
      // (probed 2026-08-12). No-op if no `think` tool is present, or if the
      // caller already set tool_choice explicitly.
      if (force_think_first && !('tool_choice' in rest) && Array.isArray(params.tools)) {
        const last = messages[messages.length - 1] as OpenAIMessage | undefined;
        const isFirstRound = !!last && last.role !== 'tool' && last.role !== 'assistant';
        const hasThink = params.tools.some((t: any) => t?.function?.name === 'think');
        if (isFirstRound && hasThink) {
          params.tool_choice = { type: 'function', function: { name: 'think' } };
        }
      }
    }

    return params;
  }

  private convertMessages(messages: any[]): OpenAIMessage[] {
    // Use flatMap to handle one-to-many expansion (multiple tool_results → multiple messages)
    return messages.flatMap(msg => {
      // If it's already in OpenAI format, pass through
      if (msg.role && (typeof msg.content === 'string' || msg.content === null || msg.tool_calls)) {
        return [msg as OpenAIMessage];
      }
      
      // Convert from Anthropic-style format
      if (Array.isArray(msg.content)) {
        const contentParts: OpenAIContentPart[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: OpenAIMessage[] = [];
        const hoistedImages: OpenAIContentPart[] = [];
        let reasoningText = '';

        for (const block of msg.content) {
          if (block.type === 'text') {
            contentParts.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            // Round-trip the reasoning trace back to the provider (OpenRouter
            // accepts `reasoning` on a prior assistant turn), mirroring how the
            // Anthropic adapter re-feeds signed thinking blocks.
            if (typeof block.thinking === 'string') {
              reasoningText += (reasoningText ? '\n' : '') + block.thinking;
            }
          } else if (block.type === 'image') {
            // Convert Anthropic-style image to OpenAI image_url with data URI
            if (block.source?.type === 'base64') {
              const mediaType = block.source.media_type ?? block.source.mediaType ?? 'image/png';
              contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${block.source.data}` },
              });
            } else if (block.source?.type === 'url') {
              contentParts.push({
                type: 'image_url',
                image_url: { url: block.source.url },
              });
            }
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          } else if (block.type === 'tool_result') {
            // Collect ALL tool results - each becomes a separate message.
            // Images inside a result are hoisted into the following user
            // message (role:'tool' content is text-only in this API).
            const { text, imageParts } = splitToolResultContent(block.content);
            toolResults.push({
              role: 'tool' as const,
              tool_call_id: block.tool_use_id || block.toolUseId,
              content: text,
            });
            hoistedImages.push(...imageParts);
          }
        }

        // If we have tool results, emit them (possibly multiple) as
        // role:'tool' messages — plus a FOLLOWING user message for images
        // hoisted out of the results and any other content sharing the
        // envelope (e.g. a mid-turn injected user message that
        // mergeConsecutiveRoles folded into the tool_result envelope),
        // instead of silently dropping it. Mirrors openai.ts / openrouter.ts.
        if (toolResults.length > 0) {
          const followParts = [...hoistedImages, ...contentParts];
          const followHasImages = followParts.some(p => p.type === 'image_url');
          // Some gateways (observed live: LiteRouter with gpt-5.1) silently
          // drop image parts from a user message that carries no text part —
          // the model then answers "no image" or re-calls the tool. Always
          // lead with a text part when images are present.
          if (followHasImages && !followParts.some(p => p.type === 'text')) {
            followParts.unshift({
              type: 'text',
              text: hoistedImages.length === 1
                ? '[image from the preceding tool result:]'
                : `[${hoistedImages.length} images from the preceding tool results:]`,
            });
          }
          const followText = followHasImages
            ? ''
            : followParts.filter(p => p.type === 'text').map(p => p.text!).join('\n');
          if (followHasImages || followText) {
            return [
              ...toolResults,
              {
                role: 'user' as const,
                content: followHasImages ? followParts : followText,
              },
            ];
          }
          return toolResults;
        }

        // Skip messages with no usable content
        if (contentParts.length === 0 && toolCalls.length === 0) {
          return [];
        }

        // Build message — use string content when there are no images (simpler, more compatible)
        const hasImages = contentParts.some(p => p.type === 'image_url');
        const textOnly = contentParts.filter(p => p.type === 'text').map(p => p.text!).join('\n');

        const result: OpenAIMessage = {
          role: msg.role,
          content: hasImages ? contentParts : (textOnly || null),
        };

        if (toolCalls.length > 0) {
          result.tool_calls = toolCalls;
        }

        if (reasoningText) {
          result.reasoning = reasoningText;
        }

        return [result];
      }
      
      return [{
        role: msg.role,
        content: msg.content,
      }];
    });
  }

  private convertTools(tools: any[]): OpenAITool[] {
    return tools.map(tool => {
      // Handle different input formats
      const inputSchema = tool.inputSchema || tool.input_schema || { type: 'object', properties: {} };
      
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: inputSchema,
        },
      };
    });
  }

  private async makeRequest(request: any, options?: ProviderRequestOptions): Promise<OpenAIResponse> {
    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      return await response.json() as OpenAIResponse;
    } finally {
      cleanup?.();
    }
  }

  private parseResponse(response: OpenAIResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private parseStreamedResponse(
    message: OpenAIMessage,
    finishReason: string,
    requestedModel: string,
    streamUsage?: OpenAIResponse['usage'],
    rawRequest?: unknown
  ): ProviderResponse {
    const cachedTokens = streamUsage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      stopSequence: undefined,
      usage: {
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
        // prompt_tokens_details.cached_tokens is OpenAI's shape: a SUBSET of
        // prompt_tokens. Declared per-response since the adapter-wide
        // convention is 'unknown' (arbitrary vendors).
        ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens, cacheConvention: 'cache-inclusive' as const } : {}),
      },
      model: requestedModel,
      rawRequest,
      raw: { message, finish_reason: finishReason, usage: streamUsage },
    };
  }

  private messageToContent(message: OpenAIMessage | undefined): ContentBlock[] {
    if (!message) return [];

    const content: ContentBlock[] = [];

    // Reasoning trace first (mirrors Anthropic thinking-block ordering).
    const reasoning = reasoningOf(message);
    if (typeof reasoning === 'string' && reasoning.trim()) {
      content.push({ type: 'thinking', thinking: reasoning } as ContentBlock);
    }

    if (message.content) {
      const raw = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text!).join('\n');
      const text = stripOrphanThinkClose(raw);
      if (text) content.push({ type: 'text', text });
    }

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments),
        });
      }
    }
    
    return content;
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      case 'content_filter':
        return 'refusal';
      default:
        return 'end_turn';
    }
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    // A deadline abort is a timeout and stays one. Collapsing it into a bare
    // abortError() here is what erased the identity before Membrane's
    // caller-signal > timeout > error ladder could read it.
    if (isDeadlineAbort(error)) return deadlineTimeoutError(error, rawRequest);
    // Already-classified failures (e.g. the stream-integrity guards) keep
    // their type and retryability instead of being re-derived from a string.
    if (error instanceof MembraneError) return error;

    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('429') || message.includes('rate')) {
        return rateLimitError(message, undefined, error, rawRequest);
      }

      if (message.includes('401') || message.includes('auth') || message.includes('Unauthorized')) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long') || message.includes('maximum context')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (message.includes('500') || message.includes('502') || message.includes('503')) {
        return serverError(message, undefined, error, rawRequest);
      }

      if (error.name === 'AbortError') {
        return abortError(undefined, rawRequest);
      }

      if (message.includes('network') || message.includes('fetch') || message.includes('ECONNREFUSED')) {
        return networkError(message, error, rawRequest);
      }
    }

    return new MembraneError({
      type: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      rawError: error,
      rawRequest,
    });
  }
}

// ============================================================================
// Content Conversion Utilities
// ============================================================================

/**
 * Convert normalized content blocks to OpenAI message format
 */
export function toOpenAIMessages(
  messages: { role: string; content: ContentBlock[] }[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  
  for (const msg of messages) {
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: { id: string; content: string }[] = [];
    let reasoningText = '';

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'thinking') {
        if (typeof (block as { thinking?: string }).thinking === 'string') {
          reasoningText += (reasoningText ? '\n' : '') + (block as { thinking: string }).thinking;
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          id: block.toolUseId,
          content: textOnlyToolResultContent(block.content),
        });
      }
    }
    
    // Add main message
    if (textParts.length > 0 || toolCalls.length > 0 || reasoningText) {
      const message: OpenAIMessage = {
        role: msg.role as 'user' | 'assistant',
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      if (reasoningText) {
        message.reasoning = reasoningText;
      }
      result.push(message);
    }
    
    // Add tool results as separate messages
    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.id,
        content: tr.content,
      });
    }
  }
  
  return result;
}

/**
 * Convert OpenAI response message to normalized content blocks
 */
export function fromOpenAIMessage(message: OpenAIMessage): ContentBlock[] {
  const result: ContentBlock[] = [];

  const reasoning = reasoningOf(message);
  if (typeof reasoning === 'string' && reasoning.trim()) {
    result.push({ type: 'thinking', thinking: reasoning } as ContentBlock);
  }

  if (message.content) {
    const raw = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text!).join('\n');
    const text = stripOrphanThinkClose(raw);
    if (text) result.push({ type: 'text', text });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      result.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments),
      });
    }
  }
  
  return result;
}

