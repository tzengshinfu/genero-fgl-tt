import * as fs from "fs";
import * as path from "path";
import { ImportType } from "./importTypes";

export interface Package extends Info {
    type: string;
    classes: PackageClass[]
}

export interface PackageClass extends Info {
    objectMethods?: Method[];
    classMethods?: Method[];
}

export interface Method extends Info {
    name: string;
    parameters?: Parameter[];
    returns?: Return[];
}

interface Info {
    name: string;
    description?: string;
    documentation?: string;
    minimumLanguageVersion?: string;
    maximumLanguageVersion?: string;
}

interface Parameter {
    name: string;
    type: string;
    description?: string;
    recordMembers?: RecordMember[];
}

interface Return {
    type: string;
    description?: string;
}

interface RecordMember {
    name: string;
    type: string;
    description?: string;
}

const PACKAGE_FILES: Record<string, string> = {
    base: "built-in_base.4GLPackage.json",
    datatypes: "built-in_dataTypes.4GLPackage.json",
    ui: "built-in_ui.4GLPackage.json",
    com: "external_com.4GLPackage.json",
    os: "external_os.4GLPackage.json",
    security: "external_security.4GLPackage.json",
    util: "external_util.4GLPackage.json",
    xml: "external_xml.4GLPackage.json"
};

const PACKAGE_CACHE = new Map<string, Package>();

export function parsePackageClasses(importList: ImportType[]) {
    let importPackages: Package[] = [];
    importList.forEach(importItem => {
        if (importItem.type == "fgl" || importItem.name == "java") {
            return;
        }
        let importPackage: Package = whatPackage(importItem.name);
        if (importPackage == null) {
            return;
        }
        try {
            importPackages.push(importPackage);
        } catch (error) {
            console.log(error);
        }
    });
    return importPackages;
}

function whatPackage(packageName: string) {
    const key = (packageName || "").toLowerCase();
    if (PACKAGE_CACHE.has(key)) return PACKAGE_CACHE.get(key);

    const fileName = PACKAGE_FILES[key];
    if (!fileName) return null;

    const candidates = [
        path.join(__dirname, "..", "Resources", fileName),
        path.join(__dirname, "..", "..", "Resources", fileName)
    ];
    const p = candidates.find(fp => fs.existsSync(fp));
    if (!p) return null;

    try {
        const raw = fs.readFileSync(p, "utf8");
        const json = JSON.parse(raw) as Package;
        if (json && json.classes) {
            PACKAGE_CACHE.set(key, json);
            return json;
        }
    } catch (err) {
        console.error("[Genero FGL] Failed to load package definition", p, err);
    }

    return null;
}
