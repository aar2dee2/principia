# Extract the person's own messages from a Claude Code transcript (.jsonl), with the agent's
# reply that followed each, as readable text. Usage: python3 -I extract.py <transcript.jsonl> <out.md>
import json, sys, re
src, out = sys.argv[1], sys.argv[2]
rows = []
for line in open(src, encoding='utf-8', errors='replace'):
    try: o = json.loads(line)
    except Exception: continue
    t = o.get('type'); m = o.get('message') or {}
    c = m.get('content')
    if isinstance(c, list):
        texts = [x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text']
        has_tool_result = any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c)
        c = '\n'.join(texts)
        if has_tool_result and not c.strip(): continue
    if not isinstance(c, str): continue
    c = c.strip()
    if not c: continue
    if t == 'user':
        # Drop harness-injected content; keep what the person typed (and pasted).
        c = re.sub(r'<system-reminder>.*?</system-reminder>', '', c, flags=re.S).strip()
        if not c or c.startswith('<task-notification>') or c.startswith('<cross-session-message') or c.startswith('[Ledger]') or c.startswith('<local-command'): continue
        if c.startswith('<command-name>') or c.startswith('<bash-input>'): continue
        if 'This session is being continued from a previous conversation' in c[:120]: continue
        rows.append(('USER', o.get('timestamp', ''), c))
    elif t == 'assistant':
        rows.append(('AGENT', o.get('timestamp', ''), c))
with open(out, 'w') as f:
    f.write(f'# {src}\n\n')
    n_user = sum(1 for r in rows if r[0] == 'USER')
    f.write(f'{n_user} messages from the person.\n\n')
    i = 0
    while i < len(rows):
        kind, ts, c = rows[i]
        if kind == 'USER':
            f.write(f'\n## USER {ts[:16]}\n{c}\n')
            # the agent's first substantive reply after it (skip one-liners like "Looking...")
            j = i + 1; shown = 0
            while j < len(rows) and rows[j][0] == 'AGENT' and shown < 2:
                if len(rows[j][2]) > 60:
                    f.write(f'\n> AGENT {rows[j][1][:16]}: {rows[j][2][:1200]}\n'); shown += 1
                j += 1
        i += 1
print(out, n_user)
