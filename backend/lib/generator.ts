import {
  LlamaContextSequence,
  LlamaChatSession,
  LlamaJsonSchemaGrammar,
} from 'node-llama-cpp';
import type { ValidateFunction } from 'ajv';
import type { GenerationOptions } from './types.js';
import { formatValidationErrors, parseJSON } from './validation.js';
import type { LLMLogger } from './llm-logger.js';

/**
 * Detect if text appears to be truncated
 *
 * Checks for common truncation patterns:
 * - Words ending with incomplete characters like "{", "[", etc.
 * - Sentences ending mid-word
 * - Incomplete JSON structures
 * 
 * WHY THIS EXISTS:
 * 
 * Problem: LLMs sometimes cut off mid-sentence, especially in longer fields
 * - Example: "This version is making{" (incomplete word)
 * - Example: "The recipient may feel frustrat{" (cut off mid-word)
 * - JSON schema grammar ensures valid JSON structure, but doesn't prevent incomplete text
 * 
 * Why not just check for incomplete JSON?
 * - JSON can be structurally valid but textually incomplete
 * - Example: {"primary": "The person is express{" - valid JSON, but truncated text
 * 
 * DETECTION STRATEGY:
 * 1. Incomplete words: Pattern like "word{" or "word[" at end
 * 2. Unclosed structures: More opening braces than closing (but only if ends with opening)
 * 3. Incomplete punctuation: Words ending with special characters
 * 
 * WHY NOT JUST CHECK LENGTH:
 * - Short fields can be complete ("Yes.")
 * - Long fields can be truncated ("This is a very long explanation that gets cut off mid-sentenc{")
 * - Pattern-based detection is more reliable
 * 
 * HOW IT RELATES TO PROMPTS:
 * - Prompts emphasize "COMPLETE fields" but LLMs still truncate sometimes
 * - This function catches truncation prompts missed
 * - Retry prompt (prompts.ts) includes truncation warnings to help LLM avoid it
 */
function isTruncated(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  const trimmed = text.trim();

  // Check for incomplete words (ending with special characters that shouldn't be at word end)
  const incompleteWordPattern = /[a-zA-Z][{[\]]$/;
  if (incompleteWordPattern.test(trimmed)) {
    return true;
  }

  // Check for incomplete sentences (ending with lowercase letter followed by nothing)
  // This catches cases like "making{" where the word is cut off
  const incompleteSentencePattern = /[a-z][{[\]]$/;
  if (incompleteSentencePattern.test(trimmed)) {
    return true;
  }

  // Check for incomplete JSON (unclosed brackets/braces at the end)
  const openBraces = (trimmed.match(/{/g) || []).length;
  const closeBraces = (trimmed.match(/}/g) || []).length;
  const openBrackets = (trimmed.match(/\[/g) || []).length;
  const closeBrackets = (trimmed.match(/\]/g) || []).length;

  // If we have unclosed structures at the end, it might be truncated
  if (openBraces > closeBraces || openBrackets > closeBrackets) {
    // But only if it ends with an opening character or incomplete structure
    if (trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.match(/[{[]\s*$/)) {
      return true;
    }
  }

  // Check for words ending with incomplete punctuation (like "making{")
  const incompleteWordEnd = /[a-zA-Z][{[\]]\s*$/;
  if (incompleteWordEnd.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Validate and fix truncated text in analysis results
 *
 * Recursively checks all string fields for truncation and throws error if found.
 * This ensures we catch truncation issues before they reach the user.
 */
function validateNoTruncation<T>(data: T, path: string = 'root'): void {
  if (typeof data === 'string') {
    if (isTruncated(data)) {
      throw new Error(`Truncated text detected at ${path}: "${data.substring(0, 50)}..."`);
    }
  } else if (Array.isArray(data)) {
    data.forEach((item, index) => {
      validateNoTruncation(item, `${path}[${index}]`);
    });
  } else if (data && typeof data === 'object') {
    Object.entries(data).forEach(([key, value]) => {
      validateNoTruncation(value, `${path}.${key}`);
    });
  }
}

/**
 * LLM Generator
 *
 * Core generation logic for creating LLM responses with:
 * - JSON schema grammar enforcement
 * - Response validation
 * - Error handling and fallback parsing
 * 
 * ARCHITECTURAL ROLE:
 * This is the "execution layer" that actually calls the LLM and handles responses.
 * It sits between:
 * - LLMService (orchestration) → Generator (execution) → node-llama-cpp (LLM)
 * 
 * WHY SEPARATE FROM LLMService:
 * - Separation of concerns: Service manages model/grammars, generator handles execution
 * - Reusability: Generator can be used by both single and batched analyses
 * - Testability: Easier to test generation logic separately
 * 
 * VALIDATION STRATEGY - Defense in Depth:
 * 1. JSON Schema Grammar (node-llama-cpp): Prevents invalid JSON structure at generation time
 * 2. Grammar.parse(): Parses and validates JSON structure
 * 3. Ajv Validator: Validates against TypeScript schema (catches grammar misses)
 * 4. Truncation Detection: Custom validation for incomplete text
 * 
 * Why multiple validation layers?
 * - Grammars prevent most issues, but don't catch everything (empty strings, wrong enums)
 * - Ajv catches schema violations grammar missed
 * - Truncation detection catches incomplete responses grammar can't prevent
 * - Together: Comprehensive validation pipeline
 */

interface GeneratorDependencies {
  contextSequence: LlamaContextSequence;
  contextSize: number;
  sessionId?: string;
  logger?: LLMLogger;
}

/**
 * Generate a response from the LLM with schema validation
 * 
 * EXECUTION FLOW:
 * 1. Log request (if logger available) - for debugging/auditing
 * 2. Create chat session with system prompt - sets LLM behavior
 * 3. Generate with grammar - constrains output to valid JSON
 * 4. Parse with grammar - validates JSON structure
 * 5. Validate with Ajv - catches schema violations grammar missed
 * 6. Check for truncation - ensures completeness
 * 7. Fallback parsing - if grammar fails, try manual JSON parse
 * 
 * ERROR HANDLING STRATEGY:
 * - Grammar parse fails → Try manual JSON parse (sometimes grammar is too strict)
 * - Manual parse fails → Throw error (will trigger retry in generateWithRetry)
 * - Validation fails → Throw error with formatted errors (will trigger retry)
 * - Truncation detected → Throw error (will trigger retry with truncation warning)
 * 
 * WHY FALLBACK PARSING:
 * - Sometimes grammar.parse() fails on valid JSON due to edge cases
 * - Manual parse (JSON.parse) is more lenient
 * - If manual parse validates with Ajv, it's acceptable
 * - Trade-off: More complex, but handles edge cases gracefully
 */
export async function generateWithSchema<T>(
  prompt: string,
  grammar: LlamaJsonSchemaGrammar<any>,
  validator: ValidateFunction<T>,
  dependencies: GeneratorDependencies,
  options: GenerationOptions = {},
  analysisType?: 'intent' | 'tone' | 'impact' | 'alternatives'
): Promise<T> {
  const { contextSequence, contextSize, sessionId, logger } = dependencies;
  const { maxTokens, temperature = 0.7 } = options;
  const maxTokensToUse = maxTokens ?? contextSize;

  // Log request if logger is available
  if (logger && sessionId && analysisType) {
    await logger.logRequest(sessionId, analysisType, prompt, { temperature, maxTokens: maxTokensToUse });
  }

  // Create a more specific system prompt based on analysis type
  let systemPrompt = 'You are a communication analysis expert. Always respond with valid, complete JSON only. Generate all required items - do not return empty arrays or incomplete responses. CRITICAL: All text fields must be COMPLETE - never truncate mid-word or mid-sentence. Every field must end with complete words and proper punctuation.';

  if (analysisType === 'alternatives') {
    systemPrompt = 'You are a communication analysis expert specializing in rewriting messages. You MUST generate complete alternatives with ALL fields filled in. NEVER return empty strings ("") for any field. Every badge, text, reason, and tag must contain actual content. CRITICAL: All text fields must be COMPLETE - never truncate mid-word or mid-sentence. Always respond with valid, complete JSON only.';
  }

  // Create a new session for this generation
  const session = new LlamaChatSession({
    contextSequence,
    systemPrompt,
  });

  let response: string | undefined;
  try {
    // Generate with JSON schema grammar enforcement
    response = await session.prompt(prompt, {
      grammar,
      maxTokens: maxTokensToUse,
      temperature,
    });

    // Log response if logger is available
    if (logger && sessionId && analysisType && response) {
      await logger.logResponse(sessionId, analysisType, response);
    }

    // Parse using grammar (handles JSON parsing and validation)
    const parsed = grammar.parse(response) as T;

    // Additional validation with Ajv as safety net
    if (!validator(parsed)) {
      const errors = formatValidationErrors(validator.errors);
      console.warn('[LLM] Validation failed. Response:', JSON.stringify(parsed, null, 2));
      console.warn('[LLM] Validation errors:', errors);

      // Log validation error
      if (logger && sessionId && analysisType) {
        await logger.logError(sessionId, analysisType, `Validation failed: ${errors}`);
      }

      throw new Error(`Validation failed: ${errors}`);
    }

    // Check for truncation in the parsed response
    try {
      validateNoTruncation(parsed);
    } catch (truncationError) {
      const errorMsg = truncationError instanceof Error ? truncationError.message : String(truncationError);
      console.warn('[LLM] Truncation detected in response:', errorMsg);
      console.warn('[LLM] Truncated response:', JSON.stringify(parsed, null, 2).substring(0, 500));

      // Log truncation error
      if (logger && sessionId && analysisType) {
        await logger.logError(sessionId, analysisType, `Truncation detected: ${errorMsg}`);
      }

      throw new Error(`Response appears truncated: ${errorMsg}`);
    }

    return parsed;
  } catch (error) {
    // Log error if logger is available
    if (logger && sessionId && analysisType) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger.logError(sessionId, analysisType, errorMessage);
    }

    // If grammar parsing fails, try manual JSON parsing as fallback
    if (error instanceof Error && response) {
      console.warn('[LLM] Grammar parse failed, trying manual parse. Raw response:', response.substring(0, 500));
      try {
        const manualParsed = parseJSON<T>(response);
        if (validator(manualParsed)) {
          // Log successful manual parse
          if (logger && sessionId && analysisType) {
            await logger.logResponse(sessionId, analysisType, response, undefined);
          }
          return manualParsed;
        } else {
          const errors = formatValidationErrors(validator.errors);
          console.warn('[LLM] Manual parse validation failed:', errors);
          console.warn('[LLM] Parsed object:', JSON.stringify(manualParsed, null, 2));
        }
      } catch (parseError) {
        console.warn('[LLM] Manual parse also failed:', parseError);
        // Fall through to throw original error
      }
    }
    throw error;
  }
}

/**
 * Generate with retry logic
 *
 * Attempts generation up to maxAttempts times, providing error feedback
 * to the LLM on retry attempts.
 * 
 * RETRY STRATEGY - Why Only 2 Attempts:
 * 
 * Design decision: maxAttempts = 2 (not 3, not 5, not infinite)
 * - First attempt: Original prompt (most succeed here)
 * - Second attempt: Enhanced prompt with error feedback (fixes most failures)
 * - Why not more: If 2 attempts fail, the issue is likely:
 *   * Model too small/incapable
 *   * Prompt needs fundamental redesign
 *   * Message is too complex/ambiguous
 *   * More retries won't help, just waste time
 * 
 * ERROR FEEDBACK MECHANISM:
 * - On failure, buildRetryPrompt() (from prompts.ts) analyzes the error
 * - Adds specific warnings based on error type (empty string, truncation, schema violation)
 * - Provides examples of correct vs incorrect output
 * - Reinforces original requirements
 * 
 * WHY THIS WORKS:
 * - LLMs are good at following instructions when given specific feedback
 * - Generic "try again" doesn't help, but "you returned empty string for 'primary' field" does
 * - Error-specific guidance helps LLM understand what went wrong
 * 
 * ALTERNATIVES CONSIDERED:
 * - Exponential backoff: Not needed - errors are usually prompt issues, not rate limits
 * - Different temperature: Tried, but error feedback is more effective
 * - Longer maxTokens: Helps with truncation, but retry with warning is better
 * 
 * HOW IT RELATES TO OTHER COMPONENTS:
 * - Called by LLMService for all analysis types
 * - Uses prompts.ts for original prompts and retry prompt building
 * - Uses schemas.ts for validation
 * - Logs to LLMLogger for debugging
 */
export async function generateWithRetry<T>(
  promptBuilder: (message: string, context?: string) => string,
  grammar: LlamaJsonSchemaGrammar<any>,
  validator: ValidateFunction<T>,
  message: string,
  dependencies: GeneratorDependencies,
  buildRetryPrompt: (original: string, error: string) => string,
  context?: string,
  options: GenerationOptions = {},
  analysisType?: 'intent' | 'tone' | 'impact' | 'alternatives'
): Promise<T> {
  const maxAttempts = 2;
  let lastError: Error | null = null;
  const { logger, sessionId } = dependencies;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const prompt =
        attempt === 1
          ? promptBuilder(message, context)
          : buildRetryPrompt(promptBuilder(message, context), lastError?.message || 'Unknown error');

      return await generateWithSchema<T>(prompt, grammar, validator, dependencies, options, analysisType);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`Attempt ${attempt}/${maxAttempts} failed:`, lastError.message);

      // Log retry attempt error
      if (logger && sessionId && analysisType) {
        await logger.logError(sessionId, analysisType, `Attempt ${attempt} failed: ${lastError.message}`, attempt);
      }

      if (attempt === maxAttempts) {
        throw new Error(`Failed after ${maxAttempts} attempts: ${lastError.message}`);
      }
    }
  }

  // TypeScript requires this, but it's unreachable
  throw lastError;
}
