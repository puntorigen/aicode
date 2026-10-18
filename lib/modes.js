// The interaction modes of a session (`--mode`, `/mode`, the IDE selector, `session.flags { mode }`).
//   auto   the router decides: a plain answer, an action template or the agent loop
//   agent  the agent loop with every tool: it reads, edits, runs commands
//   plan   the agent loop, read-only, ending in a plan file (`write_plan`)
//   ask    the agent loop, read-only, answering questions
// Kept in a module of its own so the CLI can list the choices without loading the agent stack.

'use strict';

const MODES = ['auto', 'agent', 'plan', 'ask'];

/** The mode the command line asks for: `--agent` is an alias of `--mode agent` (it never overrides another mode). */
const cliMode = ({ agent, mode }) => (agent && mode === 'auto' ? 'agent' : mode);

module.exports = { MODES, cliMode };
