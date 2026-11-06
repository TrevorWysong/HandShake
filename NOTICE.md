# Notices

HandShake's own code is licensed under the [PolyForm Shield License 1.0.0](LICENSE). In short, you can use it, including commercially, and change it, but not to provide anything that competes with it. The license itself is what counts, and this summary isn't part of it.

**Third-party software keeps its own license.** Nothing here changes those terms, and where one of them requires part of this project to be offered on its terms, that part is offered on those terms.

**Holochain.** HandShake is built with [Holochain](https://github.com/holochain/holochain), whose conductor, HDK, HDI and client are under the [Cryptographic Autonomy License 1.0](https://github.com/holochain/cryptographic-autonomy-license) and, in places, Apache-2.0. Their source code is available from [holochain/holochain](https://github.com/holochain/holochain), [holochain-hdk](https://github.com/holochain/holochain-hdk), [holochain-hdi](https://github.com/holochain/holochain-hdi) and [holochain-client-js](https://github.com/holochain/holochain-client-js). That license also protects people's control of their own keys and data. HandShake isn't affiliated with or endorsed by the Holochain project.

The zomes under `dnas/` compile these libraries in, so how the two licenses meet there is an open question for counsel (docs/ALLERGY_LEGAL_REVIEW.md).

Each dependency's license is in its package metadata (`Cargo.lock`, `package-lock.json`).
