#!/usr/bin/env python3
"""Inline style.css + JS modules into a single self-contained index.html."""
import pathlib
d = pathlib.Path(__file__).parent
head = (d/'head.html').read_text()
css = (d/'style.css').read_text()
js = '\n'.join((d/f).read_text() for f in ['core.js', 'host.js', 'clients.js'])
html = f"""{head}<style>
{css}</style>
</head>
<body>
<div id="app"></div>
<script>
{js}
</script>
</body>
</html>
"""
out = d.parent/'index.html'
out.write_text(html)
print('wrote', out, len(html), 'bytes')
