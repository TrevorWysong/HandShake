# Notices

Copyright (c) 2026 Trevor Wysong.

HandShake's own code is licensed under the Cryptographic Autonomy License version 1.0 (SPDX-License-Identifier: CAL-1.0), in [LICENSE](LICENSE). In short: anyone can use, change and share it, including commercially and to run their own network, as long as they offer the source code of what they run or share to the people using it, keep these notices, and never withhold people's own keys and data from them. The license itself is what counts, and this summary isn't part of it.

Versions released before 15 November 2026 were offered under the PolyForm Shield License 1.0.0, and stay available on those terms.

**The name and logo aren't licensed.** The license covers the code, not the HandShake name or logo: a modified version should go by a name of its own and say which project it came from. HandShake's original repository is <https://github.com/TrevorWysong/HandShake>, and who wrote it is in [AUTHORS](AUTHORS.md).

**Third-party software keeps its own license.** Nothing here changes those terms, and where one of them requires part of this project to be offered on its terms, that part is offered on those terms.

**Holochain.** HandShake is built with [Holochain](https://github.com/holochain/holochain), whose conductor, HDK, HDI and client are under the [Cryptographic Autonomy License 1.0](https://github.com/holochain/cryptographic-autonomy-license) and, in places, Apache-2.0. Their source code is available from [holochain/holochain](https://github.com/holochain/holochain), [holochain-hdk](https://github.com/holochain/holochain-hdk), [holochain-hdi](https://github.com/holochain/holochain-hdi) and [holochain-client-js](https://github.com/holochain/holochain-client-js). That license also protects people's control of their own keys and data. HandShake isn't affiliated with or endorsed by the Holochain project.

The zomes under `dnas/` compile these libraries in. HandShake is under the same license, so the combined work can be offered on CAL's terms as a whole.

Each dependency's license is in its package metadata (`Cargo.lock`, `package-lock.json`).
