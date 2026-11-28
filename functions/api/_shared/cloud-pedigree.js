import { validateTypedRelationshipId } from "../../../breeding-litter-contracts.js";

// Fetch at most one binary tree of IDs, in one database snapshot. Deduplicate
// by ID and depth here, and track cycles by branch when laying out the tree.
const pedigreeQuery = `WITH RECURSIVE
  roles(role) AS (VALUES (0), (1)),
  reachable(id, depth) AS (
    SELECT ?, 0
    UNION
    SELECT CASE role WHEN 0 THEN p.father_typed_id ELSE p.mother_typed_id END, r.depth + 1
    FROM reachable r JOIN latest_rabbit_pedigree_versions p ON p.typed_id = r.id AND p.rabbitry_id = ?
    CROSS JOIN roles
    WHERE r.depth < ? AND CASE role WHEN 0 THEN p.father_typed_id ELSE p.mother_typed_id END IS NOT NULL
  )
  SELECT p.* FROM latest_rabbit_pedigree_versions p
  JOIN (SELECT DISTINCT id FROM reachable) r ON r.id = p.typed_id
  WHERE p.rabbitry_id = ?`;

const label = value => typeof value === "string" ? value.trim() : "";
const detailFields = ["Tattoo", "Reg #", "Color", "Breed", "Weight", "DoB"];

export function buildPedigree(records, typedId, generations) {
  const root = records.get(typedId);
  if (!root || root.deleted) return null;
  const nodes = [];
  function visit(id, snapshot, path, ancestors, invalid = false) {
    const entry = records.get(id);
    const cycle = !!id && ancestors.has(id);
    const record = cycle ? null : entry?.record;
    const name = record && [label(record.Prefix), label(record.Name ?? record.name)].filter(Boolean).join(" ");
    const status = invalid ? "unavailable" : !id ? (snapshot ? "text-only" : "unknown")
      : cycle ? "cycle" : !record ? "unavailable" : entry.deleted ? "deleted"
        : record.Archived === true ? "archived" : "active";
    const details = record ? Object.fromEntries(detailFields.flatMap(field => {
      const value = record[field] ?? (field === "DoB" ? record.DOB ?? record.dob : undefined);
      return typeof value === "string" || typeof value === "number" ? [[field, String(value)]] : [];
    })) : {};
    nodes.push({ path, status, label: snapshot || name || (id || invalid ? "Unavailable" : "Unknown"), details });
    if (path.length + 1 >= generations) return;
    const branch = new Set(ancestors);
    if (id) branch.add(id);
    for (const [index, role] of ["Father", "Mother"].entries()) {
      const parentId = record?.[`${role}TypedId`];
      const snapshot = label(record?.[role]);
      const nextPath = path + index;
      if (parentId !== undefined) {
        try { validateTypedRelationshipId(parentId); }
        catch {
          visit(undefined, snapshot, nextPath, branch, true);
          continue;
        }
      }
      visit(parentId, snapshot, nextPath, branch);
    }
  }
  visit(typedId, "", "", new Set());
  return nodes;
}

export async function loadPedigree(db, rabbitryId, typedId, generations, validate) {
  const { results } = await db.prepare(pedigreeQuery).bind(typedId, rabbitryId, generations - 1, rabbitryId).all();
  const records = new Map();
  for (const row of results) {
    try {
      const item = validate(row);
      if (!Object.is(item.envelope.record._id, item.envelope.id)) throw new Error("Invalid pedigree identity");
      records.set(item.typedId, { record: item.envelope.record, deleted: row.deleted_at !== null });
    } catch (error) {
      if (row.typed_id === typedId) throw error;
    }
  }
  return buildPedigree(records, typedId, generations);
}
