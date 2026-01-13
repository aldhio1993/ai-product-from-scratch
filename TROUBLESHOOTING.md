# Troubleshooting Guide

This guide helps you diagnose and fix common issues when running the Communication Mirror project.

## Table of Contents

1. [Model Loading Issues](#model-loading-issues)
2. [Validation Errors](#validation-errors)
3. [LLM Output Problems](#llm-output-problems)
4. [Common Issues](#common-issues)
5. [Debugging Tips](#debugging-tips)

---

## Model Loading Issues

### Problem: Model fails to load

**Symptoms:**
- Backend starts but `/api/status` shows `modelReady: false`
- Error message: "Model failed to load: [error message]"
- Server logs show: "Failed to load model: ..."

**Common Causes & Solutions:**

#### 1. Model file not found

**Error message:** `ENOENT: no such file or directory` or `Cannot find model file`

**Solution:**
```bash
# Check if model file exists
ls -lh backend/models/

# Verify MODEL_PATH in .env matches actual file location
cat backend/.env

# Example: If your file is Qwen3-1.7B-Q8_0.gguf
# MODEL_PATH should be: ./models/Qwen3-1.7B-Q8_0.gguf
```

**Fix:**
- Ensure model file is in `backend/models/` directory
- Check `.env` file has correct `MODEL_PATH` (relative to backend directory)
- Use absolute path if relative path doesn't work: `MODEL_PATH=/absolute/path/to/model.gguf`

#### 2. Insufficient memory (RAM)

**Error message:** `Cannot allocate memory` or `Out of memory`

**Solution:**
- **Check available RAM:**
  ```bash
  # macOS/Linux
  free -h
  # or
  vm_stat  # macOS
  ```

- **Choose the right model for your RAM:**
  - **4-6GB RAM:** Qwen3-1.7B Q4_K_M (~3GB RAM usage)
  - **6-8GB RAM:** Qwen3-1.7B Q6_K (~5GB RAM usage) or Qwen3-4B Q4_K_M
  - **8GB+ RAM:** Qwen3-4B Q6_K (~6GB RAM usage)
  - **12GB+ RAM:** Qwen3-8B Q6_K (~8GB RAM usage)

- **Use a more quantized model** (lower quantization = less RAM):
  - Q8_0 → Q6_K (saves ~20% RAM)
  - Q6_K → Q4_K_M (saves ~30% RAM)
  - Q4_K_M → Q3_K_M (saves ~40% RAM, but lower quality)

- **Close other applications** to free up memory
- **See [Model Requirements in README](../README.md#which-models-work)** for detailed RAM requirements

#### 3. Invalid model file

**Error message:** `Invalid model format` or `Failed to parse model`

**Solution:**
- **Verify file is complete:**
  ```bash
  # Check file size (should match download size)
  ls -lh backend/models/*.gguf
  ```

- **Re-download the model:**
  - File may be corrupted during download
  - Download from [Hugging Face](https://huggingface.co/models?search=qwen3+gguf) or [TheBloke](https://huggingface.co/TheBloke)
  - Use a download manager for large files

- **Verify file extension:** Must be `.gguf` (not `.bin`, `.safetensors`, etc.)

#### 4. Model path permissions

**Error message:** `Permission denied` or `EACCES`

**Solution:**
```bash
# Check file permissions
ls -l backend/models/

# Fix permissions if needed
chmod 644 backend/models/*.gguf
```

#### 5. Node.js version incompatible

**Error message:** `node-llama-cpp` build errors or runtime errors

**Solution:**
- **Check Node.js version:**
  ```bash
  node --version  # Should be >= 18.0.0
  ```

- **Update Node.js if needed:**
  - Use [nvm](https://github.com/nvm-sh/nvm) to manage versions
  - Or download from [nodejs.org](https://nodejs.org/)

---

### Problem: Model is still loading

**Symptoms:**
- `/api/status` shows `modelReady: false, loading: true`
- Requests return: "Model is still loading. Please try again in a moment."

**Solution:**
- **Wait for model to load** (typically 10-30 seconds depending on model size and RAM)
- **Check loading progress:**
  ```bash
  # Watch backend logs
  npm run dev
  # Look for: "Model loaded successfully"
  ```

- **If loading takes too long (>2 minutes):**
  - Model might be too large for your system
  - Check RAM usage (see "Insufficient memory" above)
  - Try a smaller model

---

## Validation Errors

### Problem: Schema validation fails

**Symptoms:**
- Error: "Validation failed: [field] must NOT have fewer than 1 items"
- Error: "Validation failed: [field] must match pattern"
- Analysis returns error after LLM generation

**Common Causes & Solutions:**

#### 1. Empty arrays or strings

**Error:** `must NOT have fewer than 1 items` or `must NOT have fewer than 1 characters`

**What it means:**
- LLM returned empty array `[]` when at least 1 item is required
- LLM returned empty string `""` when text is required

**Solution:**
- **Check logs** (see [Debugging Tips](#debugging-tips)) to see what LLM returned
- **This usually auto-fixes on retry** - the system retries with enhanced prompt
- **If persists:**
  - Model might be too small/incapable
  - Try a larger model (4B or 8B instead of 1.7B)
  - Check if message is too complex/ambiguous

#### 2. Wrong data types

**Error:** `must be string` or `must be number`

**What it means:**
- LLM returned wrong type (e.g., number instead of string)

**Solution:**
- **Check JSON schema** in [`backend/lib/schemas.ts`](backend/lib/schemas.ts)
- **Verify model supports JSON schema grammars** (most GGUF models do)
- **Check logs** to see actual LLM output

#### 3. Enum value mismatch

**Error:** `must be equal to one of the allowed values`

**What it means:**
- LLM returned value not in allowed enum (e.g., "high" when only "low"|"medium"|"high" allowed)

**Solution:**
- **This is usually auto-corrected** by post-processing (see `normalizeImpactMetrics` in [`backend/lib/llm-service.ts`](backend/lib/llm-service.ts))
- **If persists:** Check if prompt needs clarification about allowed values

---

### Problem: Truncation detected

**Symptoms:**
- Error: "Response appears truncated: [incomplete text]"
- Analysis results have incomplete sentences ending with `{` or `[`

**What it means:**
- LLM cut off mid-sentence (usually due to token limits or context size)

**Solution:**
- **Check context size:**
  ```typescript
  // In backend/lib/llm-service.ts
  contextSize: 4096  // Default, might need increase
  ```

- **Increase maxTokens for alternatives:**
  ```typescript
  // Already set to 6000 in code, but check if model supports it
  maxTokens: 6000
  ```

- **Try a larger model** - smaller models truncate more often
- **Simplify the message** - very long messages might cause truncation

**Note:** The system automatically retries with truncation warnings, which usually fixes it.

---

## LLM Output Problems

### Problem: Over-interpretation (simple messages analyzed as complex)

**Symptoms:**
- Simple request like "Send the document" gets analyzed as relationship crisis
- Intent analysis finds hidden meanings in straightforward messages

**Solution:**
- **This is addressed by calibration rules** in prompts (see [`backend/lib/prompts.ts`](backend/lib/prompts.ts))
- **If persists:**
  - Try a larger model (1.7B might over-interpret, 4B+ is better)
  - Check if message actually has subtext (sometimes analysis is correct!)

### Problem: Under-interpretation (complex messages analyzed as simple)

**Symptoms:**
- Passive-aggressive messages not detected
- Emotional subtext missed

**Solution:**
- **Check if message actually has subtext** - not all messages need deep analysis
- **Review calibration rules** - they're designed to match complexity to message
- **Try a larger model** for better understanding

### Problem: Inconsistent results

**Symptoms:**
- Same message analyzed differently each time
- Results vary between requests

**Solution:**
- **This is normal** - LLMs are probabilistic, some variation is expected
- **Temperature settings:**
  ```typescript
  // Lower temperature = more consistent (but less creative)
  temperature: 0.5  // Current setting for intent/impact
  temperature: 0.6  // Current setting for tone/alternatives
  ```

- **If too inconsistent:**
  - Lower temperature to 0.3-0.4
  - Use a larger model (more consistent than smaller ones)

### Problem: Wrong sentiment or emotion detection

**Symptoms:**
- Negative emotions marked as positive
- Sentiment doesn't match emotion text

**Solution:**
- **This is auto-corrected** by post-processing (see `filterNeutralEmotions` in [`backend/lib/llm-service.ts`](backend/lib/llm-service.ts))
- **Check logs** to see original vs corrected output
- **If persists:** Model might be too small - try 4B or 8B model

---

## Common Issues

### Problem: Backend won't start

**Symptoms:**
- `npm run dev` fails
- Port already in use error

**Solution:**
```bash
# Check if port 3001 is in use
lsof -i :3001  # macOS/Linux
netstat -ano | findstr :3001  # Windows

# Kill process using port
kill -9 <PID>  # macOS/Linux
# Or change PORT in backend/.env
```

### Problem: Frontend can't connect to backend

**Symptoms:**
- Frontend shows "Request was cancelled" or connection errors
- Network errors in browser console

**Solution:**
- **Check backend is running:**
  ```bash
  # In backend directory
  npm run dev
  # Should see: "Backend server running on http://localhost:3001"
  ```

- **Check CORS settings** (should be enabled by default)
- **Verify API URL** in frontend (defaults to `/api` which proxies to backend)
- **Check browser console** for specific error messages

### Problem: Dependencies won't install

**Symptoms:**
- `npm install` fails
- Build errors

**Solution:**
```bash
# Clean install
npm run clean  # Removes all node_modules
npm install

# If still fails, check Node.js version
node --version  # Should be >= 18.0.0

# Clear npm cache
npm cache clean --force
```

### Problem: TypeScript errors

**Symptoms:**
- Build fails with TypeScript errors
- Type errors in IDE

**Solution:**
```bash
# Rebuild shared package first (other packages depend on it)
npm run build:shared

# Then build others
npm run build:backend
npm run build:frontend
```

---

## Debugging Tips

### 1. Check Model Status

**Endpoint:** `GET http://localhost:3001/api/status`

**Response shows:**
- `modelReady`: Whether model is loaded
- `loading`: Whether model is currently loading
- `error`: Any error message if loading failed

**Example:**
```bash
curl http://localhost:3001/api/status
```

### 2. View LLM Logs

**Endpoint:** `GET http://localhost:3001/api/logs`

**Shows:**
- All LLM requests and responses
- Validation errors
- Retry attempts

**Or check log files:**
```bash
# Logs are stored in backend/logs/
ls backend/logs/

# View recent logs
tail -f backend/logs/*.log
```

### 3. Enable Verbose Logging

**Check backend console output:**
```bash
# Backend logs show:
# - Model loading progress
# - Analysis requests
# - Validation errors
# - Retry attempts
npm run dev
```

**Look for:**
- `[Analyze]` - Analysis requests
- `[LLM]` - LLM generation
- `[Impact]` - Impact metric corrections
- `[Tone]` - Tone analysis corrections
- `[Alternatives]` - Alternative filtering

### 4. Test Individual Analysis Types

**Instead of full analysis, test one at a time:**

```bash
# Intent only
curl -X POST http://localhost:3001/api/analyze/intent \
  -H "Content-Type: application/json" \
  -d '{"message": "Can you send the document?"}'

# Tone only
curl -X POST http://localhost:3001/api/analyze/tone \
  -H "Content-Type: application/json" \
  -d '{"message": "Can you send the document?"}'
```

**This helps isolate which analysis type is failing.**

### 5. Check Validation Errors in Detail

**When validation fails, check:**
1. **Backend logs** - Shows full validation error
2. **LLM logs** - Shows what LLM actually returned
3. **Retry prompt** - Shows what guidance was given on retry

**Example log output:**
```
[LLM] Validation failed. Response: {"primary": "", "secondary": "..."}
[LLM] Validation errors: /primary must NOT have fewer than 1 characters
[LLM] Attempt 2/2 failed: Validation failed: ...
```

### 6. Inspect LLM Output Directly

**Check what LLM actually generated:**

```bash
# View logs for a specific session
curl http://localhost:3001/api/logs/<sessionId>

# Or check log files
cat backend/logs/<sessionId>/*.log
```

**Look for:**
- `Request:` - What prompt was sent
- `Response:` - What LLM returned
- `Error:` - Any errors during generation

### 7. Test with Simple Messages First

**Start with simple messages to verify setup:**

```bash
# Very simple message
{"message": "Hello"}

# Simple request
{"message": "Can you send the document?"}

# Then try more complex
{"message": "I've asked you three times and you still haven't sent it. This is unacceptable."}
```

**If simple messages fail, it's likely a setup issue, not a prompt issue.**

### 8. Compare Expected vs Actual Output

**Check schemas to understand expected format:**

```typescript
// [`backend/lib/schemas.ts`](backend/lib/schemas.ts)
// Shows exact structure expected for each analysis type
```

**Compare with actual LLM output in logs.**

---

## Getting Help

If you're still stuck:

1. **Check the logs** - Most issues show up in backend console or log files
2. **Verify setup** - Ensure model file exists, Node.js version is correct, dependencies installed
3. **Try a different model** - Some models work better than others
4. **Check GitHub issues** - See if others encountered the same problem
5. **Review the code** - The codebase has extensive inline documentation explaining design decisions

---

## Quick Reference: Common Error Codes

| Error Code | Meaning | Solution |
|------------|---------|----------|
| `MODEL_NOT_READY` | Model still loading or failed to load | Wait for model to load, check model file |
| `VALIDATION_FAILED` | LLM output doesn't match schema | Usually auto-fixes on retry, check logs |
| `TRUNCATED` | Response cut off mid-sentence | Usually auto-fixes on retry, try larger model |
| `INTERNAL_ERROR` | Unexpected server error | Check backend logs for details |
| `ENOENT` | File not found | Check MODEL_PATH in .env |
| `EACCES` | Permission denied | Fix file permissions |

---

**Remember:** Most validation errors are automatically retried with improved prompts. If errors persist after 2 retry attempts, check the logs to see what the LLM is actually generating.
