/**
 * 省市县区划数据：来自本地依赖 china-division（无外部服务）
 * 构建省 -> 市 -> 区县 三级树，并生成用于校验的合法组合集合
 * 直辖市的「市辖区/县」层级合并为省名本身
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = join(import.meta.dir, "..", "node_modules", "china-division", "dist");

export interface CityNode {
  name: string;
  children: string[];
}
export interface ProvinceNode {
  name: string;
  children: CityNode[];
}

interface Cache {
  tree: ProvinceNode[];
  valid: Set<string>;
}

let cache: Cache | null = null;

function build(): Cache {
  if (cache) return cache;
  const provinces = JSON.parse(
    readFileSync(join(DIST_DIR, "provinces.json"), "utf8")
  ) as { code: string; name: string }[];
  const cities = JSON.parse(
    readFileSync(join(DIST_DIR, "cities.json"), "utf8")
  ) as { code: string; name: string; provinceCode: string }[];
  const areas = JSON.parse(
    readFileSync(join(DIST_DIR, "areas.json"), "utf8")
  ) as { name: string; cityCode: string }[];

  const MUNI = new Set(["北京市", "天津市", "上海市", "重庆市"]);
  const areasByCity = new Map<string, string[]>();
  for (const a of areas) {
    const list = areasByCity.get(a.cityCode) || [];
    list.push(a.name);
    areasByCity.set(a.cityCode, list);
  }

  const valid = new Set<string>();
  const tree: ProvinceNode[] = provinces.map((p) => {
    const cityMap = new Map<string, string[]>();
    for (const ct of cities.filter((ct) => ct.provinceCode === p.code)) {
      // 直辖市的「市辖区/县」合并为省名本身，保持三级结构统一
      const cityName = MUNI.has(p.name) ? p.name : ct.name;
      if (!cityMap.has(cityName)) cityMap.set(cityName, []);
      for (const d of areasByCity.get(ct.code) || []) {
        cityMap.get(cityName)!.push(d);
      }
    }
    const children: CityNode[] = [];
    for (const [cityName, districts] of cityMap) {
      valid.add(p.name);
      valid.add(p.name + "/" + cityName);
      for (const d of districts) {
        valid.add(p.name + "/" + cityName + "/" + d);
      }
      children.push({ name: cityName, children: districts });
    }
    if (children.length === 0) valid.add(p.name); // 无下级数据的省份（如港澳台）
    return { name: p.name, children };
  });

  cache = { tree, valid };
  return cache;
}

/** 省 -> 市 -> 区 三级树（供前端联动） */
export function regionTree(): ProvinceNode[] {
  return build().tree;
}

/** 校验提交的地区串（允许 省、省/市、省/市/区 三种粒度） */
export function isValidRegion(s: string): boolean {
  return build().valid.has(s);
}
