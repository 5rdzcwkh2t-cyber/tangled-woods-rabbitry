import { handleVersionedRabbitWrite } from "./_shared/versioned-rabbit-write.js";

export function onRequestPost(context) {
  return handleVersionedRabbitWrite(context, "update");
}
