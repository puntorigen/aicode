// helper for executing HBS action code blocks and giving them context
// (absorbed from code2prompt; safe-eval replaced with node:vm)
const vm = require('vm');
const path = require('path');
const { z } = require('zod');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class codeBlocks {
    constructor() {
        this.code_blocks = [];
        this.currentFolder = process.cwd();
        this.x_console = new (require('@concepto/console'))();
        this.lastEval = '';
    }

    async executePython(context = {}, code = '') {
        process.env.REQ_TIMEOUT = '3600000'; // set pythonia timeout to 1 hour
        let python;
        try {
            ({ python } = require('pythonia'));
        } catch (err) {
            throw new Error("Python support requires the optional 'pythonia' package (npm install pythonia) and a local Python 3 installation.");
        }

        // Load the Python helper script bundled with aicode
        const py = await python(path.join(__dirname, 'python_runner.py'));

        // If context specifies packages to install, install them first
        if (context.packages && Array.isArray(context.packages)) {
            for (const pkg of context.packages) {
                const installResult = await py.install_package(pkg);
                this.x_console.out({ color:'cyan', message:`Package install log: ${installResult}` });
            }
        }

        // Convert context to JSON for passing into Python
        const contextJson = JSON.stringify(context);

        // Run the Python code
        const resultJson = await py.run_python_code(code, contextJson);

        // Parse the returned JSON from Python
        let result;
        try {
            result = JSON.parse(resultJson);
            if (result.result) result = result.result;
        } catch (err) {
            result = {};
        }

        // Close the Python interpreter
        await python.exit();
        return result;
    }

    async executeNode(context=null,code=null) {
        // context=object with variables returned by previous code blocks
        const prompts = require('prompts');
        let wAsync = `(async function() {
            ${code}
        })();\n`;
        const self = this;
        // returns methods,vars available within the code blocks contexts
        let context_ = {
            process,
            z,
            Buffer,
            URL,
            setTimeout, clearTimeout, setInterval, clearInterval,
            console: {
                log: function(message,data) {
                    self.x_console.setColorTokens({
                        '*':'yellow',
                        '#':'cyan',
                        '@':'green'
                    });
                    self.x_console.out({ color:'cyan', message:self.x_console.colorize(message), data });
                },
            },
            prompt: async(question='',validation=null)=>{
                const resp = (
                    await prompts({
                        type: 'text',
                        name: 'value',
                        message: this.x_console.colorize(question),
                        validate: (value) => {
                            if (validation) return validation(value);
                            return true
                        }
                    })
                ).value;
                return resp;
            }
        };
        if (context) {
            context_ = {...context_,...context};
        }
        // execute code block on an isolated async context
        this.lastEval = wAsync;
        const sandbox = vm.createContext(context_);
        let tmp = await vm.runInContext(wAsync, sandbox, { filename: 'action-code-block.js' });
        return tmp;
        //
    }

    async spawnBash(context = {}, code=null) {
        const { spawn } = require('child_process');
        if (!code) {
            throw new Error("Command must not be empty");
        }

        return new Promise((resolve, reject) => {
            // simplify context to only string, number, boolean
            const simpleContext = Object.keys(context).reduce((acc, key) => {
                const value = context[key];
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    acc[key] = value;
                }
                return acc;
            }, {});

            // Handle command with arguments that might include spaces
            const shell = process.platform === 'win32' ? { cmd: 'cmd', arg: '/C' } : { cmd: 'sh', arg: '-c' };
            const shellOptions = {
                env: {
                    ...process.env,
                    ...simpleContext,
                    CI: 'true',
                    npm_config_yes: 'yes',
                    CONTINUOUS_INTEGRATION: 'true'
                },
                shell: true,
                cwd: this.currentFolder
            };

            const proc = spawn(shell.cmd, [shell.arg, code], shellOptions);

            let output = ''; // To capture the output
            proc.stdout.on('data', (data) => {
                output += data.toString(); // Append real-time output
            });

            proc.stderr.on('data', (data) => {
                output += data.toString(); // Capture stderr in the output
            });

            proc.on('error', (err) => {
                reject(err);
            });

            proc.on('close', (code_) => {
                if (code_ === 0) {
                    resolve(output);
                } else {
                    reject(new Error(`Process exited with code ${code_}: ${output}`));
                }
            });
        });
    }

    async executeBash(context = {}, code = null) {
        if (!code) {
            throw new Error("No code provided for execution");
        }

        // Replace placeholders in the code with context values
        const processedCode = typeof code === 'string' ? code.replace(/\{(.*?)\}/g, (match, key) => {
            if (context[key] !== undefined) {
                return context[key];
            }
        }) : '';

        let fullScript = processedCode;

        // Set up the environment for non-interactive execution
        const simpleContext = Object.keys(context).reduce((acc, key) => {
            const value = context[key];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                acc[key] = value;
            }
            return acc;
        }, {});

        const environment = {
            ...process.env,
            ...simpleContext,
            npm_config_yes: 'yes', // Set npm to non-interactive mode
            npx_config_yes: 'yes', // Set npm to non-interactive mode
            CI: 'true', // Adding the CI environment variable
            CONTINUOUS_INTEGRATION: 'true' // Adding another common CI environment variable
        };

        try {
            const { stdout, stderr } = await execAsync(fullScript, {
                shell: '/bin/bash',
                env: environment,
                cwd: this.currentFolder // Set the current working directory to this.currentFolder
            });
            if (stderr) {
                return { output: stdout, error: stderr };
            }
            return { output: stdout };
        } catch (error) {
            throw error;
        }
    }
}

module.exports = codeBlocks;
