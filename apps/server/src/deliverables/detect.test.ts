import { describe, expect, it } from 'vitest';
import {
  MAX_DETECTED_COMMANDS,
  detectCommands,
  parseCargo,
  parseDeno,
  parseJustfile,
  parseMakefile,
  parsePackageJson,
  parsePyproject,
  shellWord,
  stripJsonc,
  type ReadResult,
} from './detect.js';

/** P9-05 — the pure parsers of run-script detection (TECHNOLOGY §9.3). */

const lines = (cs: { key: string; line: string }[]) => cs.map((c) => [c.key, c.line]);

/** A folder as `detectCommands` sees it: names → text (or a read problem). */
function folder(files: Record<string, string | ReadResult>) {
  return {
    entries: Object.keys(files),
    read: (name: string): ReadResult => {
      const f = files[name];
      if (f === undefined) return { ok: false, reason: 'missing' };
      return typeof f === 'string' ? { ok: true, text: f } : f;
    },
  };
}

describe('shellWord', () => {
  it('leaves plain names alone and single-quotes the rest', () => {
    expect(shellWord('dev')).toBe('dev');
    expect(shellWord('build:prod')).toBe('build:prod');
    expect(shellWord('@scope/x')).toBe('@scope/x');
    expect(shellWord('x; rm -rf ~')).toBe(`'x; rm -rf ~'`);
    expect(shellWord(`it's`)).toBe(`'it'\\''s'`);
    expect(shellWord('$(whoami)')).toBe(`'$(whoami)'`);
  });
});

describe('package.json', () => {
  const pkg = JSON.stringify({
    scripts: {
      build: 'tsc',
      dev: 'vite',
      predev: 'echo before',
      postinstall: 'husky',
      lint: 'eslint .',
      'x; rm -rf ~': 'oops',
      '-flag': 'nope',
      'two\nlines': 'nope',
      numeric: 3,
    },
  });

  it('lists the scripts with the package manager its lockfile names', () => {
    expect(lines(parsePackageJson(pkg, new Set(['pnpm-lock.yaml'])))).toEqual([
      ['package.json#build', 'pnpm run build'],
      ['package.json#dev', 'pnpm run dev'],
      ['package.json#lint', 'pnpm run lint'],
      ['package.json#x; rm -rf ~', `pnpm run 'x; rm -rf ~'`],
    ]);
    // `yarn run`, so a Yarn built-in never shadows a script of the same name.
    expect(parsePackageJson(pkg, new Set(['yarn.lock']))[0]!.line).toBe('yarn run build');
    expect(parsePackageJson(pkg, new Set(['bun.lockb']))[0]!.line).toBe('bun run build');
    expect(parsePackageJson(pkg, new Set(['bun.lock']))[0]!.line).toBe('bun run build');
    expect(parsePackageJson(pkg, new Set())[0]!.line).toBe('npm run build');
  });

  it('keeps the script text as the description and ranks the important names', () => {
    const [build, dev, lint] = parsePackageJson(pkg, new Set());
    expect(build).toMatchObject({ title: 'build', description: 'tsc', important: 4 });
    expect(dev).toMatchObject({ important: 0 });
    expect(lint!.important).toBeUndefined();
  });

  it('keeps what a script runs as its body, redacted like its description (S4, S5)', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const [deploy] = parsePackageJson(
      JSON.stringify({ scripts: { deploy: `curl -H "Authorization: Bearer ${token}" x` } }),
      new Set(),
    );
    expect(deploy!.line).toBe('npm run deploy');
    expect(deploy!.body).toBeDefined();
    expect(deploy!.body).toBe(deploy!.description);
    expect(deploy!.body).not.toContain(token);
    expect(deploy!.description).not.toContain(token);
  });

  it('refuses names with bidi, zero-width or separator characters', () => {
    const scripts = {
      'dev\u202e': 'x',
      'te\u200bst': 'x',
      'a\u2028b': 'x',
      'a\u2029b': 'x',
      'c1\u0085': 'x',
      ok: 'x',
    };
    expect(parsePackageJson(JSON.stringify({ scripts }), new Set()).map((c) => c.name)).toEqual([
      'ok',
    ]);
  });

  it('a package without scripts adds nothing; a malformed one throws for the caller', () => {
    expect(parsePackageJson('{"name":"x"}', new Set())).toEqual([]);
    expect(() => parsePackageJson('{"scripts": {', new Set())).toThrow(/not valid JSON/);
    expect(() => parsePackageJson('[1]', new Set())).toThrow(/not a JSON object/);
    expect(() => parsePackageJson('{"scripts": "dev"}', new Set())).toThrow(/not an object/);
  });
});

describe('Makefile', () => {
  it('lists rule targets, not special targets, patterns, variables or assignments', () => {
    const text = [
      '.PHONY: all test',
      'CC := gcc',
      'VAR ::= x',
      'OTHER = a:b',
      'all: build',
      '\t@echo all',
      'build:',
      '\tcc -o app main.c',
      'test: build ; ./app --test',
      '%.o: %.c',
      '$(OUT): x',
      'clean::',
      '\trm -f app',
      'define TEMPLATE',
      'inside: x',
      'endef',
      'two words: x',
      'all: again',
      '# comment: x',
      'deploy: \\',
      'continued: x',
    ].join('\n');
    expect(lines(parseMakefile(text))).toEqual([
      ['Makefile#all', 'make all'],
      ['Makefile#build', 'make build'],
      ['Makefile#test', 'make test'],
      ['Makefile#clean', 'make clean'],
      ['Makefile#deploy', 'make deploy'],
    ]);
  });

  it("keeps a target's recipe lines as its body", () => {
    const text = [
      'build: deps',
      '\tcc -o app \\',
      '\t  main.c',
      '',
      '\t@echo done',
      'OUT := x',
      '\tnot a recipe of build',
      'test:',
    ].join('\n');
    const [build, test] = parseMakefile(text);
    expect(build!.body).toBe('cc -o app \\\n\t  main.c\n@echo done');
    expect(test!.body).toBeUndefined();
  });

  it('reads a Makefile that would run a shell when evaluated as text only', () => {
    const text = 'X := $(shell touch /tmp/galactic-pwned)\nrun: ; $(shell rm -rf /)\n';
    expect(lines(parseMakefile(text))).toEqual([['Makefile#run', 'make run']]);
  });
});

describe('justfile', () => {
  it('lists public recipes, not assignments, settings, aliases or private ones', () => {
    const text = [
      'set shell := ["bash", "-c"]',
      'alias b := build',
      'version := "1.0"',
      'export TOKEN := "x"',
      '# the default',
      'default: build',
      '',
      'build:',
      '    cargo build',
      '@serve port="8080": build',
      '    ./serve {{port}}',
      '_helper:',
      '    true',
      '[private]',
      'secret:',
      '    true',
      '[linux]',
      'deploy target:',
      '    ./deploy {{target}}',
      'import "other.just"',
      'mod sub',
    ].join('\n');
    expect(lines(parseJustfile(text))).toEqual([
      ['justfile#default', 'just default'],
      ['justfile#build', 'just build'],
      ['justfile#serve', 'just serve'],
      ['justfile#deploy', 'just deploy'],
    ]);
    const bodies = Object.fromEntries(parseJustfile(text).map((c) => [c.name, c.body]));
    expect(bodies).toEqual({
      default: undefined,
      build: 'cargo build',
      serve: './serve {{port}}',
      deploy: './deploy {{target}}',
    });
  });
});

describe('pyproject.toml', () => {
  const text = `
[project]
name = "app"

[project.scripts]
serve = "app.server:main"
"odd name" = "app:odd"

[tool.poetry.scripts]
migrate = "app.db:migrate"
serve = "app.other:main"

[tool.pdm.scripts]
_ = { env_file = ".env" }
test = "pytest"
lint = { cmd = "ruff check ." }
`;

  it('picks uv, poetry or pdm from the lockfile, else the entry point itself', () => {
    expect(lines(parsePyproject(text, new Set(['uv.lock'])))).toEqual([
      ['pyproject.toml#serve', 'uv run serve'],
      ['pyproject.toml#odd name', `uv run 'odd name'`],
      ['pyproject.toml#migrate', 'uv run migrate'],
      ['pyproject.toml#test', 'pdm run test'],
      ['pyproject.toml#lint', 'pdm run lint'],
    ]);
    expect(parsePyproject(text, new Set(['poetry.lock']))[0]!.line).toBe('poetry run serve');
    expect(parsePyproject(text, new Set(['pdm.lock']))[0]!.line).toBe('pdm run serve');
    expect(parsePyproject(text, new Set())[0]!.line).toBe('serve');
    expect(parsePyproject(text, new Set()).find((c) => c.name === 'lint')!.description).toBe(
      'ruff check .',
    );
  });

  it('a file without scripts adds nothing; invalid TOML throws for the caller', () => {
    expect(parsePyproject('[project]\nname = "x"\n', new Set())).toEqual([]);
    expect(() => parsePyproject('[project\nname = ', new Set())).toThrow(/not valid TOML/);
    expect(() => parsePyproject('a = 1\na = 2\n', new Set())).toThrow(/not valid TOML/);
  });
});

describe('Cargo.toml', () => {
  it('a single package: cargo run and cargo test', () => {
    expect(lines(parseCargo('[package]\nname = "app"\nversion = "0.1.0"\n'))).toEqual([
      ['Cargo.toml#run', 'cargo run'],
      ['Cargo.toml#test', 'cargo test'],
    ]);
  });

  it('named binaries: cargo run --bin per binary', () => {
    const text = `[package]\nname = "app"\n\n[[bin]]\nname = "server"\npath = "src/server.rs"\n\n[[bin]]\nname = "cli tool"\n`;
    expect(lines(parseCargo(text))).toEqual([
      ['Cargo.toml#run:server', 'cargo run --bin server'],
      ['Cargo.toml#run:cli tool', `cargo run --bin 'cli tool'`],
      ['Cargo.toml#test', 'cargo test'],
    ]);
  });

  it('a virtual workspace: cargo test only; garbage throws for the caller', () => {
    expect(lines(parseCargo('[workspace]\nmembers = ["a"]\n'))).toEqual([
      ['Cargo.toml#test', 'cargo test'],
    ]);
    expect(parseCargo('# nothing\n')).toEqual([]);
    expect(() => parseCargo('[package\n')).toThrow(/not valid TOML/);
  });
});

describe('deno.json(c)', () => {
  it('lists tasks as deno task <t>', () => {
    const text = JSON.stringify({
      tasks: { dev: 'deno run -A main.ts', check: { command: 'deno check', description: 'types' } },
    });
    expect(lines(parseDeno(text))).toEqual([
      ['deno.json#dev', 'deno task dev'],
      ['deno.json#check', 'deno task check'],
    ]);
    expect(parseDeno(text)[1]!.description).toBe('types');
  });

  it('reads JSONC comments and trailing commas, and keeps strings with // in them', () => {
    const text = `{
      // tasks
      "tasks": {
        /* the server */
        "serve": "deno run --allow-net https://example.com/x.ts", // trailing
      },
    }`;
    expect(stripJsonc('{"a": "x // y", /* z */ "b": 1,}')).toBe('{"a": "x // y",  "b": 1}');
    expect(lines(parseDeno(text, 'deno.jsonc'))).toEqual([['deno.jsonc#serve', 'deno task serve']]);
    expect(() => parseDeno('{"tasks": [}', 'deno.json')).toThrow(/not valid JSON/);
  });
});

describe('detectCommands', () => {
  it('orders the important names first, then the files in their fixed order', () => {
    const out = detectCommands(
      folder({
        'package.json': JSON.stringify({ scripts: { lint: 'x', test: 'y', dev: 'z' } }),
        'pnpm-lock.yaml': '',
        Makefile: 'build:\n\tcc\nclean:\n\trm\n',
        'compose.yaml': 'services: {}\n',
        'deno.json': JSON.stringify({ tasks: { start: 'deno run main.ts' } }),
        'README.md': '# not read',
      }),
    );
    expect(lines(out.commands)).toEqual([
      ['package.json#dev', 'pnpm run dev'],
      ['deno.json#start', 'deno task start'],
      ['Makefile#build', 'make build'],
      ['package.json#test', 'pnpm run test'],
      ['package.json#lint', 'pnpm run lint'],
      ['Makefile#clean', 'make clean'],
      ['compose.yaml#up', 'docker compose up'],
    ]);
    expect(out.files).toEqual(['package.json', 'Makefile', 'compose.yaml', 'deno.json']);
    expect(out.problems).toEqual([]);
  });

  it('reads only the first Makefile, justfile, Compose and deno file each tool would read', () => {
    const out = detectCommands(
      folder({
        Makefile: 'a:\n',
        GNUmakefile: 'b:\n',
        'docker-compose.yml': 'services: {}\n',
        'compose.yml': 'services: {}\n',
        'deno.jsonc': '{"tasks": {"x": "y"}}',
        'deno.json': '{"tasks": {"z": "y"}}',
      }),
    );
    expect(out.commands.map((c) => c.key)).toEqual([
      'GNUmakefile#b',
      'compose.yml#up',
      'deno.json#z',
    ]);
  });

  it('a malformed or unreadable file adds nothing and is reported; the others still count', () => {
    const out = detectCommands(
      folder({
        'package.json': '{ "scripts": { "dev": ',
        'pyproject.toml': '[[[',
        'Cargo.toml': { ok: false, reason: 'is larger than 1024 KiB' },
        'compose.yaml': '   \n',
        justfile: 'build:\n  make\n',
      }),
    );
    expect(lines(out.commands)).toEqual([['justfile#build', 'just build']]);
    expect(out.problems.map((p) => p.file)).toEqual([
      'package.json',
      'pyproject.toml',
      'Cargo.toml',
    ]);
    expect(out.problems[0]!.reason).toMatch(/not valid JSON/);
    expect(out.problems[2]!.reason).toBe('is larger than 1024 KiB');
  });

  it(`lists at most ${MAX_DETECTED_COMMANDS} and counts the rest`, () => {
    const scripts = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`s${i}`, 'x']).concat([['test', 'vitest']]),
    );
    const out = detectCommands(folder({ 'package.json': JSON.stringify({ scripts }) }));
    expect(out.commands).toHaveLength(MAX_DETECTED_COMMANDS);
    expect(out.commands[0]!.key).toBe('package.json#test');
    expect(out.overflow).toHaveLength(11);
    expect(out.overflow.at(-1)).toBe('package.json#s59');
  });

  it('an empty folder detects nothing', () => {
    expect(detectCommands(folder({}))).toEqual({
      commands: [],
      overflow: [],
      problems: [],
      files: [],
    });
  });
});
