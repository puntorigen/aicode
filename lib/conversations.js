// Conversation helpers shared by the Agent Server and (later) the Cursor /
// aicode conversation readers. This first cut only holds `projectSlug`, the
// name of a project's per-user directory: ~/.aicode/projects/<slug>/sessions.
'use strict';

/**
 * Cursor's project slug for an absolute path: every non-alphanumeric character
 * becomes `-` and leading dashes are dropped. aicode names its own
 * ~/.aicode/projects/<slug> directories the same way, so one function serves both.
 *
 *   /Users/me/Documents/code/aicode -> Users-me-Documents-code-aicode
 */
function projectSlug(absPath) {
    return String(absPath).replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '');
}

module.exports = { projectSlug };
