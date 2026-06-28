import { strict as assert } from "node:assert";
import test from "node:test";
import { redactConversationDetail } from "../src/commands/conversation.js";

test("redactConversationDetail summarizes custom field attributes", () => {
  const result = redactConversationDetail({
    id: 123,
    subject: "Custom field test",
    custom_field_attributes: [
      { id: 1, custom_field_id: 272081, value: "true", private_payload: "hidden" },
    ],
  }) as any;

  assert.equal(result.customFieldAttributes.count, 1);
  assert.deepEqual(result.customFieldAttributes.items, [
    { id: 1, custom_field_id: 272081, value: "true" },
  ]);
});
