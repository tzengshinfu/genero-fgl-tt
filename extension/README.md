
# [English](/extension/README.md)｜[繁體中文](/extension/README_ZH.md)

## Genero fglcomp/fglform command adapter

[![Marketplace Version](https://vsmarketplacebadges.dev/version-short/m121752332.genero-fgl.png)](https://marketplace.visualstudio.com/items?itemName=m121752332.genero-fgl)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/m121752332.genero-fgl.png)](https://marketplace.visualstudio.com/items?itemName=m121752332.genero-fgl)
[![Rating](https://vsmarketplacebadges.dev/rating-short/m121752332.genero-fgl.png)](https://marketplace.visualstudio.com/items?itemName=m121752332.genero-fgl)

## Provides

* syntax highlighting (4gl, per)
* formatting (4gl)
* go to definition (4gl)
* completion (4gl, per)
* diagnostic - underlining errors and warnings - (4gl,per)
* hover (4gl)
* breadcrumps (4gl)
* debugging
* tasks

## Snippets

The extension now provides configurable 4GL snippets through settings.

Setting key:

```json
"GeneroFGL.4gl.snippets"
```

Each object key is a stable snippet id. The value defines the snippet:

```json
{
  "prefix": "if",
  "description": "Insert IF ... END IF",
  "body": [
    "IF ${1:condition} THEN",
    "   ${0}",
    "END IF"
  ],
  "enabled": true
}
```

Behavior:

* the extension ships default snippets in package.json
* users can override a built-in snippet by reusing the same snippet id in settings.json
* users can add new snippets by adding a new snippet id
* setting `enabled` to `false` hides that snippet from completion

Example:

```json
"GeneroFGL.4gl.snippets": {
  "IF_BLOCK": {
    "prefix": "ifi",
    "description": "Custom IF block",
    "body": [
      "IF ${1:condition} THEN",
      "      ${0}",
      "END IF"
    ],
    "enabled": true
  },
  "SELECT_INTO": {
    "prefix": "sel",
    "description": "SELECT ... INTO template",
    "body": [
      "SELECT ${1:*}",
      "  INTO ${2:target}.*",
      "  FROM ${3:table}",
      " WHERE ${0:condition}"
    ],
    "enabled": true
  }
}
```

The completion provider merges built-in snippets with user settings at runtime, so unchanged built-in snippets remain available.

## Debugging

* launch using the internalConsole, integratedTerminal, externalTerminal.
* attach to a fglrun process by picking an process id from a list.

## Building

The extension contributes 'genero-fgl' tasks (code:Terminal/Run Task, code:Terminal/Run Build Task).

Configure your own build task (Terminal/Configure Tasks).
Important: set the attribute **"problemMatcher": "$fglcomp"**, otherwise
vscode can not parse the output of fglcomp and fglform.

Example 1: compile everything in the workplace:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "fglcomp-all-4gl",
      "type": "shell",
      "command": "fglcomp -r --make -M *.4gl",
      "problemMatcher": "$fglcomp",
      "options": {
        "cwd": "${workspaceFolder}"
      },
      "group": {
        "kind": "build",
      }
    }
  ]
}
```

Example 2: launch make

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "make",
      "type": "shell",
      "command": "make",
      "problemMatcher": "$fglcomp",
      "options": {
        "cwd": "${workspaceFolder}"
      },
      "group": "build"
    }
  ]
}
```

## Changes

### 0.0.10

* contributes the problemMatcher fglcomp (See Building)

### 0.0.12

* hover - context information for the symbol under the cursor.
* Fixed syntax highlighting of multi-line string literals.
* diagnostics: Better handling of fast user input on slow machines.

### 0.0.13

* contributes tasks
* breadcrumps

### 0.0.14

* references
* language server (experimental)

### 0.0.15

* fixes: diagnostic not working on Windows.

## 0.0.16

* fixes: Run/Run Without Debugging.
* debugger: configuration option stopAtEntry (default true).

## 0.0.17

* syntax highlighting - escape characters in strings

```4gl
LET var = "abc\n"
```

* syntax highlighting - preprocessor

```4gl
& define FOO bar
```

* syntax highlighting - scree/grid in per files

```per
SCREEN
{
  Field1 [f1  ]
  Field2 [f2  ]
}
```

## 0.0.18

* housekeeping

## 0.0.19

* housekeeping: smaller package

## 0.0.20

* fixes: debugger configuration attribute "stopAtEntry": true
