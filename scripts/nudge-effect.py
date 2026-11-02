# How the agent reacted to each Principia nudge in a transcript: within the turn after a
# "[Ledger] …" prompt, did it call the ledger tool, run a command, edit, or only talk?
import json, sys, re, collections
kinds = {'verify': 'Done but not verified', 'open': 'Asked but not started', 'tests': 'since the last passing test', 'gaps': 'close these gaps', 'captured': 'Captured from this message', 'still': 'Still open from earlier'}
for src in sys.argv[1:]:
    rows = []
    for line in open(src, encoding='utf-8', errors='replace'):
        try: o = json.loads(line)
        except Exception: continue
        rows.append(o)
    stats = collections.defaultdict(lambda: collections.Counter())
    examples = collections.defaultdict(list)
    for i, o in enumerate(rows):
        if o.get('type') != 'user': continue
        c = (o.get('message') or {}).get('content')
        if isinstance(c, list): c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
        if not isinstance(c, str): continue
        kind = next((k for k, s in kinds.items() if s in c), None)
        if not kind or not c.lstrip().startswith(('[Ledger]', 'The principia plugin sent')): 
            if kind in ('captured', 'still'): pass
            else: continue
        if kind in ('captured', 'still'): continue  # context, not a nudge
        # what followed, until the next user message that is a real prompt
        tools = collections.Counter(); said = ''
        for o2 in rows[i+1:i+80]:
            if o2.get('type') == 'user':
                c2 = (o2.get('message') or {}).get('content')
                if isinstance(c2, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c2): continue
                break
            if o2.get('type') == 'assistant':
                for x in (o2.get('message') or {}).get('content') or []:
                    if isinstance(x, dict) and x.get('type') == 'tool_use': tools[x.get('name')] += 1
                    if isinstance(x, dict) and x.get('type') == 'text' and not said: said = x.get('text', '')[:200].replace('\n', ' ')
        stats[kind]['nudges'] += 1
        if tools.get('mcp__principia__ledger'): stats[kind]['updated ledger'] += 1
        if tools.get('Bash'): stats[kind]['ran commands'] += 1
        if any(t in tools for t in ('Edit', 'Write', 'MultiEdit')): stats[kind]['edited'] += 1
        if not tools: stats[kind]['only talked'] += 1
        if len(examples[kind]) < 2: examples[kind].append(said)
    print('==', src.split('/')[-2][:60], src.split('/')[-1][:8])
    for k, c in stats.items(): print('  ', k, dict(c)); 
    for k, ex in examples.items():
        for e in ex: print('     e.g.', k, '→', e)
