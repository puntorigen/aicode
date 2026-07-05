// aicode engine (absorbed from code2prompt v1.1.4)
// - context half: directory traversal, source tree, Handlebars templates,
//   custom file viewers, schema extraction, code block execution (unchanged)
// - transport half: Vercel AI SDK (generateObject/streamText) with
//   multi-provider routing + fallback (replaces llm-api/zod-gpt)

const fs = require("fs-extra");
const fs_ = require("fs").promises;
const path = require("path");
const handlebars = require("handlebars");
const { glob } = require("glob");
const codeBlocks = require('code-blocks')
const { z } = require('zod');
const models = require('./models');

// per-process cache of directory snapshots (one CLI invocation = one process)
const traverseCache = new Map();

// per-turn usage ledger (reset at the start of each pipeline turn); shared
// across every engine instance created during that turn so index.js can print
// a single aggregated model/token/cost footer.
let usageLedger = [];

class Code2Prompt {
  constructor(options) {
    this.options = options;
    this.extensions = options.extensions ? [].concat(options.extensions) : [];
    this.ignorePatterns = options.ignore ? [].concat(options.ignore) : [];
    // if specified, enforces a return schema (use zod)
    this.schema = options.schema ? (options.schema) : null;
    this.code_blocks = {};
    this.QArecordings = {};
    this.last_QAsession = null;
    this.full_source_tree = false; //false=source_tree equals to files shown on prompt, true=source_tree contains all files ignoring exclusions
    this.binary = false; // false=skips binary files
    this.custom_viewers = options.custom_viewers ? (options.custom_viewers) : {}; // registered custom file viewers (ex. docx, xlsx, pdf, etc)
    // provider credentials & local model config
    this.config = {
      OPENAI_KEY: options.OPENAI_KEY || null,
      GROQ_KEY: options.GROQ_KEY || null,
      ANTHROPIC_KEY: options.ANTHROPIC_KEY || null,
      LOCAL_BASE_URL: options.LOCAL_BASE_URL || null,
      LOCAL_MODEL: options.LOCAL_MODEL || null,
      LOCAL_FAST_MODEL: options.LOCAL_FAST_MODEL || null,
      LOCAL_API_KEY: options.LOCAL_API_KEY || null,
      LOCAL_CONTEXT: options.LOCAL_CONTEXT || null,
      LOCAL_EFFORT: options.LOCAL_EFFORT || null,
      // optional smart-model / effort overrides (set via ~/.aicode/keys.json or env)
      OPENAI_MODEL: options.OPENAI_MODEL || null,
      ANTHROPIC_MODEL: options.ANTHROPIC_MODEL || null,
      ANTHROPIC_EFFORT: options.ANTHROPIC_EFFORT || null,
      GROQ_MODEL: options.GROQ_MODEL || null,
    };
    // legacy aliases (kept for backwards compatibility)
    this.OPENAI_KEY = this.config.OPENAI_KEY;
    this.GROQ_KEY = this.config.GROQ_KEY;
    this.ANTHROPIC_KEY = this.config.ANTHROPIC_KEY;
    this.maxBytesPerFile = options.maxBytesPerFile ? (options.maxBytesPerFile) : 8192;
    this.debugger = options.debugger ? (options.debugger) : false;
    this.modelPreferences = ["OPENAI", "ANTHROPIC", "GROQ", "LOCAL"];
    this.model_preferences = this.modelPreferences; // legacy alias
    this.defaultTier = options.tier || 'smart';
    this.system = options.system || null; // optional system prompt for LLM calls
    this.streamHandler = options.streamHandler || null; // optional (chunk)=>{} for free-text streaming
    this.abortSignal = options.abortSignal || null; // optional AbortSignal to cancel in-flight calls
    this.templateDir = this.options.template ? path.dirname(this.options.template) : process.cwd();
    this.loadAndRegisterTemplate(this.options.template);
  }

  debug(message) {
    if (this.debugger) console.log('[aicode-engine]: ' + message);
  }

  setModelPreferences(preferences) {
    // accept and filter unknown providers
    this.modelPreferences = [].concat(preferences).filter((p) => !!models.PROVIDERS[p]);
    // always keep LOCAL as last-resort fallback if configured
    if (!this.modelPreferences.includes('LOCAL') && models.hasCredentials('LOCAL', this.config)) {
      this.modelPreferences.push('LOCAL');
    }
    this.model_preferences = this.modelPreferences;
    this.debug('Model preferences updated: ' + JSON.stringify(this.modelPreferences));
  }

  setSystemPrompt(text) {
    this.system = text;
  }

  setStreamHandler(fn) {
    this.streamHandler = fn;
  }

  setAbortSignal(signal) {
    this.abortSignal = signal || null;
  }

  setLLMAPI(provider, value) {
    if (provider === 'ANTHROPIC') {
      this.config.ANTHROPIC_KEY = this.ANTHROPIC_KEY = value;
      return true;
    } else if (provider === 'GROQ') {
      this.config.GROQ_KEY = this.GROQ_KEY = value;
      return true;
    } else if (provider === 'OPENAI') {
      this.config.OPENAI_KEY = this.OPENAI_KEY = value;
      return true;
    } else if (provider === 'LOCAL') {
      // value: { baseURL, model, fastModel, apiKey, contextSize }
      if (value && typeof value === 'object') {
        this.config.LOCAL_BASE_URL = value.baseURL || this.config.LOCAL_BASE_URL;
        this.config.LOCAL_MODEL = value.model || this.config.LOCAL_MODEL;
        this.config.LOCAL_FAST_MODEL = value.fastModel || this.config.LOCAL_FAST_MODEL;
        this.config.LOCAL_API_KEY = value.apiKey || this.config.LOCAL_API_KEY;
        this.config.LOCAL_CONTEXT = value.contextSize || this.config.LOCAL_CONTEXT;
        return true;
      }
    }
    return false;
  }

  registerFileViewer(ext, method) {
    this.custom_viewers[ext] = method;
    this.debug(`Viewer registered for ${ext}`);
  }

  recordQA(session = '') {
    this.last_QAsession = session;
    if (!this.QArecordings[session]) this.QArecordings[session] = [];
  }

  getQArecordings(session) {
    return this.QArecordings[session];
  }

  async extractCodeBlocks(text) {
    // extract code blocks from a given text (maybe from an LLM response)
    return (await codeBlocks.fromString(text)).map((i) => ({
      lang: i.lang,
      code: i.value
    }));
  }

  async loadAndRegisterTemplate(templatePath) {
    let templateContent;
    this.code_blocks = [];
    if (templatePath) {
      templateContent = await fs.readFile(templatePath, 'utf-8');
    } else {
      // Fallback to a default template if not provided
      templateContent = `Project Path: {{absolute_code_path}}
      
Source Tree:

\`\`\`
{{source_tree}}
\`\`\`

{{#each files}}
{{#if code}}
\`{{path}}\`:

{{{code}}}

{{/if}}
{{/each}}
`;
    }
    this.template = handlebars.compile(templateContent);
    // extract return schema from template
    if (this.template) {
      const code_blocks = await codeBlocks.fromString(templateContent)
      if (code_blocks.length > 0) {
        // extract 'lang' defined code blocks into 'this.code_blocks' and remove them from template
        // if lang is 'schema' assign to schema
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (let i = 0; i < code_blocks.length; i++) {
          const block = code_blocks[i];
          // remove code block statement from template
          if (block.lang) {
            const original = '```' + block.lang + '\n' + block.value + '\n```';
            if (templateContent.includes(original)) {
              templateContent = templateContent.replace(original, "");
            } else {
              // tolerate trailing whitespace/blank lines between the block value and the closing fence
              const flexible = new RegExp('```' + escapeRegex(block.lang) + '\\r?\\n' + escapeRegex(block.value) + '\\s*```');
              templateContent = templateContent.replace(flexible, "");
            }
          }
          //
          if (block.lang === 'schema' || block.lang === 'json:schema') {
            // build zod schema from template schema
            const json_parsed = JSON.parse(block.value);
            const zod_schema = z.object({ schema: this.createZodSchema(json_parsed) });
            if (!this.schema) this.schema = zod_schema;
          } else if (block.lang) {
            this.code_blocks.push({ lang: block.lang, code: block.value });
          }
        }
        this.template = handlebars.compile(templateContent);
      }
    }
  }

  adjustIgnorePatterns(ignorePatterns, extensionsNotIgnored) {
    // Ensure all extensions in extensionsNotIgnored start with a dot
    const normalizedExtensions = extensionsNotIgnored.map(ext => ext.startsWith('.') ? ext : `.${ext}`);

    return ignorePatterns.reduce((acc, pattern) => {
      // Check if the pattern directly relates to a file extension
      if (pattern.startsWith('**/*.')) {
        // Extract the extension from the pattern
        const extPattern = path.extname(pattern);
        // Check if this extension is in the normalized list of extensions not to ignore
        if (normalizedExtensions.includes(extPattern)) {
          // If it is, do not add this pattern to the final list of ignore patterns
          return acc;
        }
      }
      // Otherwise, add the pattern to the final list
      acc.push(pattern);
      return acc;
    }, []);
  }

  async readContent(filePath, maxBytes) {
    if (maxBytes !== null) {
      const fileHandle = await fs_.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
        return buffer.toString('utf-8', 0, bytesRead);
      } finally {
        await fileHandle?.close();
      }
    } else {
      return fs.readFile(filePath, 'utf-8');
    }
  }

  // invalidate the per-process snapshot cache (e.g. after writing files)
  static invalidateTraverseCache() {
    traverseCache.clear();
  }

  // usage ledger (per pipeline turn)
  static resetUsage() {
    usageLedger = [];
  }

  static getUsage() {
    const byModel = {};
    let inputTokens = 0, outputTokens = 0, cost = 0;
    for (const e of usageLedger) {
      inputTokens += e.inputTokens || 0;
      outputTokens += e.outputTokens || 0;
      cost += models.estimateCost(e.model, e.inputTokens, e.outputTokens);
      byModel[e.model] = (byModel[e.model] || 0) + 1;
    }
    return {
      model: Object.keys(byModel).join(', '),
      models: byModel,
      inputTokens,
      outputTokens,
      cost,
      calls: usageLedger.length,
    };
  }

  _recordUsage(provider, tier, usage = {}) {
    try {
      const model = models.modelId(provider, tier, this.config);
      const inputTokens = usage.inputTokens != null ? usage.inputTokens : (usage.promptTokens != null ? usage.promptTokens : 0);
      const outputTokens = usage.outputTokens != null ? usage.outputTokens : (usage.completionTokens != null ? usage.completionTokens : 0);
      usageLedger.push({ provider, tier, model, inputTokens, outputTokens });
    } catch (e) { /* usage accounting is best-effort */ }
  }

  async traverseDirectory(dirPath, maxBytes = this.maxBytesPerFile) {
    const absolutePath = path.resolve(dirPath);
    const cacheKey = JSON.stringify([absolutePath, maxBytes, this.extensions, this.ignorePatterns, Object.keys(this.custom_viewers)]);
    if (traverseCache.has(cacheKey)) {
      return traverseCache.get(cacheKey);
    }
    const ignorePatternsWithoutViewers = this.adjustIgnorePatterns(this.ignorePatterns, Object.keys(this.custom_viewers));
    const files = await glob("**", { cwd: absolutePath, nodir: true, absolute: true, ignore: ignorePatternsWithoutViewers, dot: true });
    let tree = {};
    let filesArray = [];

    for (let file of files) {
      const extension = path.extname(file).toLowerCase();
      if (this.extensions.length === 0 || this.extensions.includes(extension.substring(1))) {
        const relativePath = path.relative(absolutePath, file);
        const parts = relativePath.split(path.sep);
        let current = tree;

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (i === parts.length - 1) {
            current[part] = relativePath;
            let content = '';
            if (extension in this.custom_viewers) {
              this.debug(`Found custom viewer for ${extension}, file: ${file}`);
              content = await this.custom_viewers[extension](file);
            } else {
              content = await this.readContent(file, maxBytes);
            }
            filesArray.push({ path: relativePath, code: content });
          } else {
            current[part] = current[part] || {};
            current = current[part];
          }
        }
      }
    }
    // Convert the tree object to a string representation similar to the source tree in the template
    const sourceTree = this.stringifyTree(tree);
    const result = { absolutePath, sourceTree, filesArray };
    traverseCache.set(cacheKey, result);
    return result;
  }

  stringifyTree(tree, prefix = '') {
    let result = '';
    Object.keys(tree).forEach((key, index, array) => {
      const isLast = index === array.length - 1;
      result += `${prefix}${isLast ? '└── ' : '├── '}${key}\n`;
      if (typeof tree[key] === 'object') {
        result += this.stringifyTree(tree[key], `${prefix}${isLast ? '    ' : '|   '}`);
      }
    });
    return result;
  }

  stringifyTreeFromPaths(paths) {
    const tree = {};

    // Build the tree
    paths.forEach((filePath) => {
      const parts = filePath.split(path.sep);
      let current = tree;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          // It's a file, we stop here
          current[part] = filePath;
        } else {
          // It's a directory
          if (!current[part]) {
            current[part] = {};
          }
          current = current[part];
        }
      });
    });

    // Stringify the tree
    const stringifyTree_ = (tree, prefix = '') => {
      let result = '';
      const keys = Object.keys(tree);
      keys.forEach((key, index) => {
        const isLast = index === keys.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        result += `${prefix}${connector}${key}\n`;
        if (typeof tree[key] === 'object' && Object.keys(tree[key]).length > 0) {
          result += stringifyTree_(tree[key], `${prefix}${isLast ? '    ' : '|   '}`);
        }
      });
      return result;
    };

    return stringifyTree_(tree);
  }

  async executeBlocks(pre = true, context_ = {}) {
    const code_helper = new (require('./codeBlocks'));
    const code_blocks = await this.getCodeBlocks();
    for (const block of code_blocks) {
      // test if block.lang ends with ':pre' or not; if pre is false, then only run if block.lang doesn't contains ':'
      if ((pre && block.lang.endsWith(':pre')) || (!pre && block.lang.indexOf(':') == -1)) {
        // if block.lang contains 'js'
        if (block.lang.includes('js')) {
          const code_executed = await code_helper.executeNode(context_, block.code);
          // if code_executed is an object
          if (typeof code_executed === 'object') {
            context_ = { ...context_, ...code_executed };
          }
        } else if (block.lang.includes('python')) {
          // if block.lang contains 'python'
          context_ = { ...context_, templateDir: this.templateDir };
          const code_executed = await code_helper.executePython(context_, block.code);
          if (typeof code_executed === 'object') {
            context_ = { ...context_, ...code_executed };
          }
        } else if (block.lang.includes('bash')) {
          const code_executed = await code_helper.executeBash(context_, block.code);
          if (code_executed.vars) {
            context_ = { ...context_, ...code_executed.vars };
          }
        }
      }
    }
    return context_;
  }

  async executeNode(context_ = {}, code) {
    const code_helper = new (require('./codeBlocks'));
    const code_executed = await code_helper.executeNode(context_, code);
    return code_executed;
  }

  async executeBash(context_ = {}, code) {
    const code_helper = new (require('./codeBlocks'));
    const code_executed = await code_helper.executeBash(context_, code);
    return code_executed;
  }

  async executePython(context_ = {}, code) {
    const code_helper = new (require('./codeBlocks'));
    const context__ = { ...context_, templateDir: this.templateDir };
    const code_executed = await code_helper.executePython(context__, code);
    return code_executed;
  }

  async spawnBash(context_ = {}, code) {
    const code_helper = new (require('./codeBlocks'));
    const code_executed = await code_helper.spawnBash(context_, code);
    return code_executed;
  }

  async runTemplate(prompt = '', methods = {}, context = {}) {
    const code_helper = new (require('./codeBlocks'));
    const base_methods = {
      queryLLM: async (question, schema) => {
        return await this.queryLLM(question, schema);
      },
      queryContext: async (question, schema) => {
        return await this.request(question, schema);
      },
      extractCodeBlocks: this.extractCodeBlocks
    };
    const methods_ = {
      ...base_methods, ...methods, ...{
        executeScript: async (code) => {
          const code_executed = await code_helper.executeNode({ ...base_methods, ...methods, ...context }, code);
          return code_executed;
        }
      }
    };
    //build handlebar template prompt first (to also get initial context vars)
    const context_prompt = await this.generateContextPrompt(null, true, context);
    let context_ = { ...methods_, ...context_prompt.context };
    //search x:pre codeblocks and execute
    context_ = await this.executeBlocks(true, context_);
    //execute prompt template if template contains a handlebar besides scripts
    if (context_prompt.rendered.trim() != '') {
      const template_res = await this.request(prompt, null, {
        custom_variables: { ...context_ }
      });
      context_ = {
        ...context_, ...{
          schema: template_res.data
        }
      };
    }
    //search x codeblocks and execute
    context_ = await this.executeBlocks(false, context_);

    return context_;
  }

  async generateContextPrompt(template = null, object = false, variables = {}) {
    if (template) {
      await this.loadAndRegisterTemplate(template);
    }
    let variables_ = { ...variables }; // clone param
    let { absolutePath, sourceTree, filesArray } = await this.traverseDirectory(this.options.path);
    if (Object.keys(variables_).length > 0) {
      if (!variables_.absolute_code_path) variables_.absolute_code_path = absolutePath;
      if (!variables_.source_tree) variables_.source_tree = sourceTree;
      if (!variables_.files) variables_.files = filesArray;
    } else {
      variables_ = {
        absolute_code_path: absolutePath,
        source_tree: sourceTree,
        files: filesArray
      };
    }
    let rendered = this.template(variables_);
    if (object) {
      return {
        context: variables_,
        rendered: rendered
      };
    }
    return rendered;
  }

  getCodeBlocks() {
    return this.code_blocks;
  }

  //
  // LLM transport (Vercel AI SDK)
  //

  // executes fn(model, provider) against providers in preference order,
  // falling back to the next provider on error
  async _withProviderFallback(promptText, tier, fn) {
    let preferences = [...this.modelPreferences];
    const promptTokens = models.estimateTokens(promptText);
    let lastError;

    while (preferences.length > 0) {
      const provider = models.resolveProvider(preferences, this.config, promptTokens);
      if (!provider) break; // no suitable provider among remaining preferences
      this.debug(`Chosen LLM provider: ${provider} (tier: ${tier}, ~${promptTokens} tokens)`);
      try {
        const model = models.createModel(provider, tier, this.config);
        return await fn(model, provider);
      } catch (err) {
        lastError = err;
        this.debug(`LLM provider ${provider} failed with error: ${err.message}`);
        preferences = preferences.filter(p => p !== provider);
        this.debug(`Remaining preferences after failure: ${JSON.stringify(preferences)}`);
      }
    }
    throw new Error(`All LLM providers failed. Last error: ${lastError ? lastError.message : 'no suitable provider (missing API keys or prompt too large)'}`);
  }

  // core completion: schema -> generateObject, no schema -> streamText
  // stream=true additionally emits chunks to this.streamHandler (used only for
  // main template requests, so intermediate helper calls don't pollute the terminal)
  async _complete(promptText, wrappedSchema, tier, stream = false) {
    const { generateObject, streamText } = require('ai');
    return await this._withProviderFallback(promptText, tier, async (model, provider) => {
      // effort-derived provider options (e.g. Anthropic extended thinking budget)
      const call = models.callOptions(provider, tier, this.config, { structured: !!wrappedSchema });
      const callExtras = {
        ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
        ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
      };
      if (wrappedSchema) {
        const response = await generateObject({
          model,
          schema: wrappedSchema,
          prompt: promptText,
          ...(this.system ? { system: this.system } : {}),
          ...(this.abortSignal ? { abortSignal: this.abortSignal } : {}),
          ...callExtras
        });
        const usage = response.usage || {};
        this._recordUsage(provider, tier, usage);
        return { data: response.object, usage };
      } else {
        const response = streamText({
          model,
          prompt: promptText,
          ...(this.system ? { system: this.system } : {}),
          ...(this.abortSignal ? { abortSignal: this.abortSignal } : {}),
          ...callExtras
        });
        let full = '';
        for await (const chunk of response.textStream) {
          full += chunk;
          if (stream && this.streamHandler) {
            try { this.streamHandler(chunk); } catch (e) { }
          }
        }
        const usage = await response.usage.catch(() => ({}));
        this._recordUsage(provider, tier, usage);
        return { data: full, usage };
      }
    });
  }

  async queryLLM(prompt = '', schema = null, options = {}) {
    // query the LLM without context, with fallback to next provider if fails
    const tier = options.tier || this.defaultTier;
    let return_ = { data: {}, usage: {} };

    if (schema) {
      // keep zod-gpt-compatible wrapping: { schema: <user schema> }
      const wrapped = z.object({ schema });
      const response = await this._complete(prompt, wrapped, tier);
      return_.data = (response.data && response.data.schema !== undefined) ? response.data.schema : response.data;
      return_.usage = response.usage;
    } else {
      const response = await this._complete(prompt, null, tier);
      return_.data = response.data;
      return_.usage = response.usage;
    }
    return return_;
  }

  async request(prompt = '', schema = null, options = {
    custom_context: null,
    meta: false,
    custom_variables: {}
  }) {
    const tier = options.tier || this.defaultTier;
    if (schema) {
      this.schema = z.object({ schema });
    }

    // Prepare context
    let context_;
    let context;
    if (!options.custom_context) {
      context_ = await this.generateContextPrompt(null, true, options.custom_variables);
      context = context_.rendered;
    } else {
      context_ = { context: options.custom_context, rendered: '' };
      context = '';
    }

    let fullPrompt = prompt ? (context + '\n\n# ' + prompt) : context;
    let return_ = { data: {}, usage: {} };

    // request() is the main template call: stream free-text output to the terminal
    const response = await this._complete(fullPrompt, this.schema, tier, true);
    if (this.schema && response.data && response.data.schema !== undefined) {
      return_.data = response.data.schema;
      return_.usage = response.usage;
    } else {
      return_.data = response.data;
      return_.usage = response.usage;
    }

    if (options.meta) {
      return_.context = context_.context;
      return_.code_blocks = this.code_blocks;
    }

    // add to this.QArecordings[this.last_QAsession] if exists
    if (this.last_QAsession) {
      this.QArecordings[this.last_QAsession] = {
        question: prompt,
        answer: return_.data
      };
    }

    return return_;
  }

  createZodSchema(input) {
    if (Array.isArray(input)) {
      // Handle arrays; assumes first element structure for all elements
      if (input.length === 0) {
        return z.array(z.unknown());
      } else {
        return z.array(this.createZodSchema(input[0]));
      }
    } else if (typeof input === 'object' && input !== null) {
      // Handle objects
      const schemaFields = Object.keys(input).reduce((acc, key) => {
        // Use the value as description for nested fields if it's a string
        const fieldValue = input[key];
        acc[key] = typeof fieldValue === 'string' ? this.createZodSchema(fieldValue, key) : this.createZodSchema(fieldValue);
        return acc;
      }, {});
      return z.object(schemaFields);
    } else if (typeof input === 'string') {
      // Use the string value as the description
      return z.string().describe(input);
    } else {
      // For all other types, default to using z.string() without description
      return z.string();
    }
  }
}

module.exports = Code2Prompt;
