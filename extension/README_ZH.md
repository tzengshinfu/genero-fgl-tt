# [English](/extension/README.md)｜[繁體中文](/extension/README_ZH.md)

## Genero fglcomp/fglform 指令介面

[![Marketplace Version](https://vsmarketplacebadges.dev/version-short/m121752332.genero-fgl.png)](https://marketplace.visualstudio.com/items?itemName=m121752332.genero-fgl)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/m121752332.genero-fgl.png)](https://marketplace.visualstudio.com/items?itemName=m121752332.genero-fgl)
[![Rating](https://vsmarketplacebadges.dev/rating-short/m121752332.genero-fgl.png)](https://marketplace.visualstudio.com/items?itemName=m121752332.genero-fgl)

## 功能

* 語法高亮（4gl, per）
* 格式化（4gl）
  * 建議人工格式化或是範圍選取格式化
* 跳轉定義（4gl）
* 自動完成（4gl, per）
* 診斷 - 錯誤與警告底線標示 -（4gl, per）
* 懸浮提示（4gl）
* 導覽列（4gl）
* 除錯
* 任務

## Snippets

擴充功能現在支援透過設定管理 4GL snippets。

設定鍵：

```json
"GeneroFGL.4gl.snippets"
```

每個物件 key 是穩定的 snippet id，value 則是 snippet 定義：

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

行為規則：

* 擴充功能會在 package.json 內提供預設 snippets
* 使用者可在 settings.json 使用相同 snippet id 覆蓋內建 snippet
* 使用者可新增新的 snippet id 來擴充自己的 snippets
* 將 `enabled` 設為 `false` 可隱藏該 snippet，不出現在補全列表

範例：

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

補全提供器會在執行時合併內建 snippets 與使用者設定，所以沒有被覆蓋的內建 snippet 仍會保留。

## 除錯

* 可使用 internalConsole、integratedTerminal、externalTerminal 啟動。
* 可選擇 fglrun 程序 ID 進行附加。

## 建置

此擴充功能提供 'genero-fgl' 任務（code:Terminal/Run Task, code:Terminal/Run Build Task）。

可自訂建置任務（Terminal/Configure Tasks）。
重要：請設置屬性 **"problemMatcher": "$fglcomp"**，否則 vscode 無法解析 fglcomp 與 fglform 的輸出。

範例 1：編譯工作區所有檔案：

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

範例 2：執行 make

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
