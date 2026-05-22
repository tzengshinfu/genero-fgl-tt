const assert = require('assert');
const Module = require('module');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

class SnippetString {
  constructor(value) {
    this.value = value;
  }
}

class CompletionList {
  constructor(items, isIncomplete) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

const vscodeStub = {
  Position,
  Range,
  CompletionItem,
  SnippetString,
  CompletionList,
  CompletionItemKind: {
    Snippet: 15
  },
  workspace: {
    getConfiguration() {
      return {
        inspect() {
          return {};
        }
      };
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { loadSnippets, buildSnippetCompletions } = require('../src/providers/snippetProvider.ts');

describe('snippetProvider', () => {
  it('merges defaults with user overrides by snippet id', () => {
    const config = {
      inspect() {
        return {
          defaultValue: {
            IF_BLOCK: {
              prefix: 'if',
              description: 'default',
              body: ['IF ${1:x} THEN', '   ${0}', 'END IF'],
              enabled: true
            },
            FOR_BLOCK: {
              prefix: 'for',
              body: ['FOR ...', 'END FOR'],
              enabled: true
            }
          },
          globalValue: {
            IF_BLOCK: {
              prefix: 'ifi',
              description: 'override',
              body: ['IF ${1:cond} THEN', '      ${0}', 'END IF'],
              enabled: true
            },
            CUSTOM_BLOCK: {
              prefix: 'sel',
              body: ['SELECT ...'],
              enabled: true
            }
          }
        };
      }
    };

    const snippets = loadSnippets(config);
    assert.strictEqual(snippets.IF_BLOCK.prefix, 'ifi');
    assert.strictEqual(snippets.FOR_BLOCK.prefix, 'for');
    assert.strictEqual(snippets.CUSTOM_BLOCK.prefix, 'sel');
  });

  it('builds enabled snippet completion items filtered by prefix', () => {
    const document = {
      lineAt() {
        return { text: 'if' };
      }
    };
    const position = new vscodeStub.Position(0, 2);
    const wordRange = new vscodeStub.Range(0, 0, 0, 2);
    const snippets = {
      IF_BLOCK: {
        prefix: 'if',
        description: 'Insert IF',
        body: ['IF ${1:condition} THEN', '   ${0}', 'END IF'],
        enabled: true
      },
      IF_DISABLED: {
        prefix: 'ifx',
        body: ['IFX'],
        enabled: false
      },
      FOR_BLOCK: {
        prefix: 'for',
        body: ['FOR'],
        enabled: true
      }
    };

    const items = buildSnippetCompletions(document, position, 'if', wordRange, snippets);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].label, 'if');
    assert.strictEqual(items[0].kind, vscodeStub.CompletionItemKind.Snippet);
    assert.strictEqual(items[0].insertText.value, 'IF ${1:condition} THEN\n   ${0}\nEND IF');
  });
});