# Third-party notices

The Windows helper and CLI include .NET10.0.14 (Microsoft/.NET Foundation,
MIT license) and bundled dependency notices. Complete runtime notices are in
`licenses/runtime/dotnet-10.0.14/`.
Source: https://github.com/dotnet/runtime/tree/v10.0.14

Development tests use @playwright/test, Playwright and playwright-core1.64.1
(Microsoft, Apache License2.0), pinned in package-lock.json. Their license and
notices are in `licenses/development/playwright/`. Downloaded browser binaries
stay generated locally and are not distributed in the Windows package or source.
Source: https://github.com/microsoft/playwright/tree/v1.64.1

Test fixtures use invented data. D&D Beyond account captures, credentials and
licensed rules prose are not included in the source repository or release.
