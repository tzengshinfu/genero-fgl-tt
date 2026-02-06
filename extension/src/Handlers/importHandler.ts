import * as vscode from "vscode";
import { Package, PackageClass, Method } from "./packageHandler";
import { ImportType } from "./importTypes";

export function getImportList(document: vscode.TextDocument) {
    let importList: ImportType[] = [];
    let commentBlock: boolean = false;
    let endImports: RegExp = new RegExp("^\\s*(public|private|define|type|constant|function|main|report|options|&define|&include)\\b", "i");
    let commentPosition: number = -1;
    let importSection: string = "";

    for (let i = 0; i < document.lineCount; i++) {
        let line: string = document.lineAt(i).text.trim();

        // Skip blank lines
        if (!line.length) {
            continue;
        }

        // Check for comment block ending
        if (commentBlock) {
            commentPosition = line.search("}");
            if (commentPosition >= 0) {
                commentBlock = false;
                line = line.substring(commentPosition + 1).trim();
                if (!line.length) {
                    continue;
                }
            }
        }

        // Trim off any line comments
        commentPosition = line.search("(--|#)");
        if (commentPosition >= 0) {
            line = line.substring(0, commentPosition).trim();
            if (!line.length) {
                continue;
            }
        }

        // Check for comment block start
        commentPosition = line.search("{");
        if (commentPosition >= 0) {
            commentBlock = true;
            line = line.substring(0, commentPosition).trim();
            if (!line.length) {
                continue;
            }
        }

        // Check for end of import range
        let match: RegExpExecArray = endImports.exec(line);
        if (match != null) {
            break;
        }

        // At this point everything should be trimmed so we can just create a
        // big string
        importSection = `${importSection} ${line}`;
    }

    let imports: Array<string> = importSection.trim().split(new RegExp("\\bimport\\b", "i"));

    imports.forEach(element => {
        element = element.trim();
        // Skip blank elements
        if (!element.length) {
            return;
        }
        let words: Array<string> = element.split(" ");
        if (words[0].toLowerCase() == "fgl" || words[0].toLowerCase() == "java") {
            importList.push({type: words[0], name: words[1]});
        }
        else {
            importList.push({name: words[0]});
        }
    });

    return importList;
}

function getChainInfo(document: vscode.TextDocument, position: vscode.Position) {
    const line = document.lineAt(position.line).text;
    const prefix = line.substring(0, position.character);

    const trailingDotMatch = /([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.$/.exec(prefix);
    if (trailingDotMatch) {
        const chain = trailingDotMatch[1];
        const parts = chain.split(".");
        return {
            parts,
            partial: "",
            start: position.character,
            end: position.character,
            trailingDot: true
        };
    }

    const match = /([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/.exec(prefix);
    if (!match) {
        return null;
    }

    const chain = match[1];
    const parts = chain.split(".");
    const last = parts[parts.length - 1] || "";
    const start = position.character - last.length;
    return {
        parts,
        partial: last,
        start,
        end: position.character,
        trailingDot: false
    };
}

function matchesPrefix(name: string, prefix: string) {
    if (!prefix) return true;
    return name.toLowerCase().startsWith(prefix.toLowerCase());
}

function addCompletion(
    items: vscode.CompletionItem[],
    label: string,
    kind: vscode.CompletionItemKind,
    range: vscode.Range,
    detail?: string,
    documentation?: string
) {
    const item = new vscode.CompletionItem(label, kind);
    item.range = range;
    if (detail) item.detail = detail;
    if (documentation) item.documentation = new vscode.MarkdownString(documentation);
    items.push(item);
}

function getClassByName(pkg: Package, className: string): PackageClass | undefined {
    return pkg.classes.find(c => c.name.toLowerCase() === className.toLowerCase());
}

function collectMethods(klass: PackageClass): Method[] {
    const out: Method[] = [];
    if (klass.objectMethods) out.push(...klass.objectMethods);
    if (klass.classMethods) out.push(...klass.classMethods);
    return out;
}

function buildMethodDetail(className: string, method: Method): string {
    const params = (method.parameters || []).map(p => `${p.name}: ${p.type}`).join(", ");
    return `${className}.${method.name}(${params})`;
}

export function importCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    imports: Package[]
) {
    let completions: vscode.CompletionItem[] = [];

    const chain = getChainInfo(document, position);
    if (!chain) return completions;

    const range = new vscode.Range(position.line, chain.start, position.line, chain.end);

    // No dot context: suggest packages and classes
    if (chain.parts.length === 1 && !chain.trailingDot) {
        const prefix = chain.partial;
        const seen = new Set<string>();
        for (const pkg of imports) {
            if (matchesPrefix(pkg.name, prefix) && !seen.has(`pkg:${pkg.name}`)) {
                addCompletion(completions, pkg.name, vscode.CompletionItemKind.Module, range, "package");
                seen.add(`pkg:${pkg.name}`);
            }
            for (const klass of pkg.classes) {
                if (matchesPrefix(klass.name, prefix) && !seen.has(`class:${klass.name}`)) {
                    addCompletion(
                        completions,
                        klass.name,
                        vscode.CompletionItemKind.Class,
                        range,
                        pkg.name,
                        klass.description
                    );
                    seen.add(`class:${klass.name}`);
                }
            }
        }
        return completions;
    }

    const packageName = chain.parts[0];
    const pkg = imports.find(p => p.name.toLowerCase() === packageName.toLowerCase());
    if (!pkg) return completions;

    // Package -> class completion
    if (chain.parts.length === 2 && !chain.trailingDot) {
        const prefix = chain.partial;
        for (const klass of pkg.classes) {
            if (matchesPrefix(klass.name, prefix)) {
                addCompletion(
                    completions,
                    klass.name,
                    vscode.CompletionItemKind.Class,
                    range,
                    pkg.name,
                    klass.description
                );
            }
        }
        return completions;
    }

    // Package.Class -> method completion
    const className = chain.parts[1];
    const klass = getClassByName(pkg, className);
    if (!klass) return completions;

    const methodPrefix = chain.trailingDot ? "" : chain.partial;
    const methods = collectMethods(klass);
    for (const method of methods) {
        if (matchesPrefix(method.name, methodPrefix)) {
            addCompletion(
                completions,
                method.name,
                vscode.CompletionItemKind.Method,
                range,
                buildMethodDetail(className, method),
                method.description || method.documentation
            );
        }
    }

    return completions;
}
