// Session-history helpers shared by the TUI and the Agent Server.

// Keep the last `maxTurns` user/assistant pairs and stay under a rough char
// budget (~8k tokens ≈ 32k chars), dropping the oldest pairs first.
function trimSessionHistory(history, maxTurns = 10, maxChars = 32000) {
    let msgs = (history || []).slice(-maxTurns * 2);
    const size = (arr) => arr.reduce((n, m) => n + (m && m.content ? String(m.content).length : 0), 0);
    while (msgs.length > 2 && size(msgs) > maxChars) msgs = msgs.slice(2);
    return msgs;
}

module.exports = { trimSessionHistory };
