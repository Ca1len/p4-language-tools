#!/usr/bin/env python3
"""Package the dependency-free VS Code extension and language server as a VSIX."""
import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

ROOT = Path(__file__).resolve().parent
EXT = ROOT / 'extension'
SERVER = ROOT / 'server'
manifest = json.loads((EXT / 'package.json').read_text(encoding='utf-8'))
name, version, publisher = (manifest[k] for k in ('name', 'version', 'publisher'))
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / f'{name}-{version}.vsix'

vsix = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Language="en-US" Id={quoteattr(name)} Version={quoteattr(version)} Publisher={quoteattr(publisher)} />
    <DisplayName>{escape(manifest.get('displayName', name))}</DisplayName>
    <Description xml:space="preserve">{escape(manifest.get('description', ''))}</Description>
    <Tags>P4,Programming Languages</Tags><Categories>Programming Languages</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value={quoteattr(manifest['engines']['vscode'])}/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="p4" ContentType="text/plain"/>
  <Default Extension="license" ContentType="text/plain"/>
  <Override PartName="/extension/server/p4include/LICENSE" ContentType="text/plain"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>'''

with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('extension.vsixmanifest', vsix)
    for base, prefix in ((EXT, 'extension'), (SERVER, 'extension/server')):
        for path in sorted(base.rglob('*')):
            if base == SERVER and path.relative_to(base).parts[:2] == ('vendor-antlr', 'source'):
                continue
            if not path.is_file() or path.name.endswith('.test.js') or any(p in {'node_modules', '__pycache__', '.git', 'test', 'tests'} for p in path.relative_to(base).parts):
                continue
            z.write(path, f'{prefix}/{path.relative_to(base).as_posix()}')
print(output)
