---
name: run-local
description: Build and run the current .NET service locally on localhost:5000 in the background, with readiness check and cleanup. Use this when the user wants to run a service locally, start the service, test against localhost, or debug locally.
---

## Starting the Service

Run the `run-local.sh` script (located in the same directory as this skill file) from the root of the service repository. Pass the project directory or `.csproj` path as the first argument when the service project is not `WebApi`. Use a 3 minute timeout since the build and startup can take a while.

The script handles everything: verifying the project structure, checking for port conflicts, detecting the build configuration, building, starting in the background, and polling for readiness.

The script defaults to `WebApi` when no project argument is provided. It auto-detects the build configuration from the selected `.csproj`. Services often define custom configurations (LOCAL, DEV, TEST, PROD) without the standard Debug/Release. The script prefers LOCAL, then DEV, then falls back to the dotnet default.

## Stopping the Service

When the user asks to stop the service, or when you are done with it:

```bash
kill $(lsof -ti :5000)
```
