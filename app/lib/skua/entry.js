// Run one method of a Skua script, the way other Skua scripts do it: include the file, make an instance of its
// class and call the method. Farmer Joe works exactly like this (`private MasterRanger MR = new(); ... MR.GetMR();`),
// so a goal like "MasterRanger.cs#GetMR" runs the same code in the engine as it would inside Farmer Joe.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The public class that declares `method` (first public class if none does).
function classFor(source, method) {
  const re = /\bpublic\s+(?:partial\s+|sealed\s+)*class\s+(\w+)/g;
  const classes = [];
  let m;
  while ((m = re.exec(source))) classes.push({ name: m[1], at: m.index });
  if (!classes.length) return null;
  const decl = new RegExp(`\\b(?:public|internal)\\s+(?:static\\s+)?(?:async\\s+)?[\\w<>\\[\\],\\s]+?\\s+${method}\\s*\\(`);
  const hit = decl.exec(source);
  if (!hit) return null;
  let owner = classes[0];
  for (const c of classes) if (c.at < hit.index) owner = c;
  return { name: owner.name, isStatic: /\bstatic\b/.test(hit[0]) };
}

// Writes the wrapper script and returns its path. `args` is the argument text to pass (optional).
function wrapper(scriptsRoot, scriptPath, method, outDir, args = '') {
  // A path inside the library is included the Skua way ("Scripts/..."); any other file by its full path,
  // which Skua's include resolver accepts too.
  const abs = path.isAbsolute(String(scriptPath));
  const rel = abs ? path.resolve(String(scriptPath)).replace(/\\/g, '/') : String(scriptPath).replace(/\\/g, '/').replace(/^Scripts\//, '');
  const file = abs ? rel : path.join(scriptsRoot, rel);
  const source = fs.readFileSync(file, 'utf8');
  const cls = classFor(source, method);
  if (!cls) throw new Error(`${rel} has no public method ${method}`);
  const hash = crypto.createHash('sha1').update(`${rel}#${method}(${args})`).digest('hex').slice(0, 8);
  const name = `SeraphEntry_${cls.name}_${method}_${hash}`.replace(/[^\w]/g, '_');
  const call = cls.isStatic ? `${cls.name}.${method}(${args});` : `new ${cls.name}().${method}(${args});`;
  const code = [
    '/*',
    `name: ${cls.name}.${method}`,
    `description: Seraph runs ${rel} -> ${method}(${args}) in Skua's engine`,
    'tags: seraph',
    '*/',
    '//cs_include Scripts/CoreBots.cs',
    abs ? `//cs_include ${rel}` : `//cs_include Scripts/${rel}`,
    'using Skua.Core.Interfaces;',
    '',
    `public class ${name}`,
    '{',
    '    public IScriptInterface Bot => IScriptInterface.Instance;',
    '    public CoreBots Core => CoreBots.Instance;',
    '',
    '    public void ScriptMain(IScriptInterface bot)',
    '    {',
    '        Core.SetOptions();',
    `        ${call}`,
    '        Core.SetOptions(false);',
    '    }',
    '}',
    '',
  ].join('\n');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${name}.cs`);
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== code) fs.writeFileSync(out, code);
  return out;
}

module.exports = { wrapper, classFor };
