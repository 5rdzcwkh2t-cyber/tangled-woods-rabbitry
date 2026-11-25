import { validateLitterEnvelope, validateTypedRelationshipId } from "../../../breeding-litter-contracts.js";

export const kitLinkFields = ["litterTypedId", "FatherTypedId", "MotherTypedId"];
export const kitSnapshotFields = [...kitLinkFields, "Father", "Mother"];

export async function inheritKitRecord(env, rabbitryId, litterTypedId, record) {
  const row = await env.DB.prepare(
    `SELECT deleted_at, envelope FROM litter_record_versions
     WHERE rabbitry_id = ? AND typed_id = ? ORDER BY revision DESC LIMIT 1`
  ).bind(rabbitryId, litterTypedId).first();
  if (!row || row.deleted_at !== null) return null;
  const { record: litter } = validateLitterEnvelope(JSON.parse(row.envelope));
  validateTypedRelationshipId(litter.sireTypedId);
  validateTypedRelationshipId(litter.damTypedId);
  return {
    ...record, litterTypedId,
    FatherTypedId: litter.sireTypedId, MotherTypedId: litter.damTypedId,
    Father: litter.Sire, Mother: litter.Dam, DoB: litter.Born, Breed: litter.Breed ?? "",
    Sex: record.Sex ?? record.sex ?? "Unknown"
  };
}
