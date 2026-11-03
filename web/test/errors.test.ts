import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../src/lib/ui/errors";
import { useLocale } from "../src/i18n";
import { en } from "../src/i18n/en";
import { es } from "../src/i18n/es";

/// A zome call's failure, as the client reports it.
const refused = (message: string) => new Error(`Wasm runtime error while working with Ribosome: RuntimeError: dispatch::bids:41: Guest("${message.replace(/"/g, '\\"')}")`);

function inSpanish(run: () => void) {
  useLocale.setState({ locale: "es", catalog: es });
  try {
    run();
  } finally {
    useLocale.setState({ locale: "en", catalog: en });
  }
}

test("a refusal reads as its sentence, in English as written", () => {
  assert.equal(describeError(refused("This order isn't taking offers any more.")), "This order isn't taking offers any more.");
});

test("a refusal from a zome another one called reads as its sentence too", () => {
  // A payment's refusal, from dispatch, inside another zome's call to it.
  const nested = new Error(`Wasm runtime error while working with Ribosome: RuntimeError: holochain::core::ribosome::host_fn::call:239: Host("Wasm runtime error while working with Ribosome: RuntimeError: handshake_coordinator_support:14: Guest(\\"That isn't a payment of yours.\\")")`);
  assert.equal(describeError(nested), "That isn't a payment of yours.");
  const quoted = new Error(`RuntimeError: call:239: Host("RuntimeError: x:1: Guest(\\"The \\\\\\"Fries\\\\\\") are gone.\\")")`);
  assert.equal(describeError(quoted), 'The "Fries") are gone.');
  assert.equal(describeError(refused('The "Fries") are gone.')), 'The "Fries") are gone.', "an escaped quote and bracket don't end it");
  const award = new Error(`RuntimeError: call:239: Host("RuntimeError: support:14: Guest(\\"You can ask for up to what the store kept: 2000.\\")")`);
  assert.match(describeError(award), /^You can ask for up to what the store kept: \D*20\.00\D*\.$/);
  inSpanish(() => assert.match(describeError(award), /^Puedes pedir como máximo lo que se quedó la tienda: \D*20[.,]00\D*\.$/));
});

test("in Spanish, a refusal is translated, its values filled back in", () => {
  inSpanish(() => {
    assert.equal(describeError(refused("This order isn't taking offers any more.")), "Este pedido ya no acepta ofertas.");
    assert.equal(describeError(refused("That code isn't right. 2 tries left.")), "Ese código no es correcto. Te quedan 2 intentos.");
    // An amount comes back in the network's currency, not as minor units.
    assert.match(describeError(refused("You can ask for up to what the store kept: 2500.")), /^Puedes pedir como máximo lo que se quedó la tienda: \D*25[.,]00\D*\.$/);
  });
});

test("the runtime's refusals are translated too, not only the zomes'", () => {
  inSpanish(() => {
    assert.equal(describeError(new Error("That isn't a code from HandShake's move to a new phone.")), "Ese no es un código del traslado de HandShake a un teléfono nuevo.");
  });
});

test("a zome's diagnostic says something went wrong, with the detail kept", () => {
  assert.equal(describeError(refused("could not read back bid")), "Something went wrong (could not read back bid). Try again.");
  inSpanish(() => assert.equal(describeError(refused("could not read back bid")), "Algo salió mal (could not read back bid). Inténtalo de nuevo."));
});

test("anything else is left as it is", () => {
  assert.equal(describeError(new Error("The connection to your node dropped mid-request.")), "The connection to your node dropped mid-request.");
});

test("a write the network's rules refused says what was refused, without the trace", () => {
  // As placing an order reported it: the order checked as a nested call saved.
  const promo = new Error(`Wasm runtime error while working with Ribosome: RuntimeError: holochain::core::ribosome::host_fn::call:239: Host("Source chain error: InvalidCommit error: Validation failed while committing: that promo has been used as many times as it allows")`);
  assert.equal(describeError(promo), "Not allowed: That promo has been used as many times as it allows.");
  const direct = new Error(`Wasm runtime error while working with Ribosome: RuntimeError: Source chain error: InvalidCommit error: Validation failed while committing: a goodie bag is one to a line, with nothing to choose`);
  assert.equal(describeError(direct), "Not allowed: A goodie bag is one to a line, with nothing to choose.");
  inSpanish(() => assert.equal(describeError(promo), "No permitido: That promo has been used as many times as it allows."));
});

test("a failure that passes on its own says to try again, and no trace is ever shown", () => {
  const behind = new Error(`Wasm runtime error while working with Ribosome: RuntimeError: holochain::core::ribosome::host_fn::call:239: Host("Source chain error: The commit could not be completed but may be retried: DepMissingFromDht([AnyDhtHash(uhCkk...)])")`);
  assert.equal(describeError(behind), "The network is still catching up. Try again in a moment.");
  const odd = new Error(`Wasm runtime error while working with Ribosome: RuntimeError: holochain::core::ribosome::host_fn::get:51: Host("KeystoreError")`);
  assert.equal(describeError(odd), "Something went wrong. Try again.");
  assert.equal(describeError(new Error("Couldn't reach the store.")), "Couldn't reach the store.", "plain words pass through");
});
