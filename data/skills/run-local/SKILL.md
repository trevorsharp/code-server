---
name: run-local
description: Build and run the current .NET WebApp service locally for testing or debugging
---

## Starting the service

- Run the bundled [`run-local.sh`](run-local.sh) script, passing the service repository root as its only argument.
- Use a 3 minute timeout since the build and startup can take a while.
- The script runs `WebApp/WebApp.csproj` using the `Debug` build configuration and `ASPNETCORE_ENVIRONMENT=LOCAL`.
- The project's launch profile supplies the remaining local environment variables.
- The service will be available on port 5000 by default.
- To run on a port other than 5000, set `HOST_PORT` when invoking the bundled script. This is required when running multiple services at the same time.

```bash
HOST_PORT=5001 run-local.sh {repository-root}
```

## Stopping the service

When the user asks to stop the service, or when you are done with it, kill the process using the port.

```bash
kill $(lsof -ti :5001)
```
