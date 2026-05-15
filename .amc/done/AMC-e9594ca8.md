# AMC-e9594ca8 — Fix Python adapter packaging (declare runtime deps)

## What was built
Declared the runtime dependency on `agentgit-adapter>=0.1.0` for the three new
Python adapters (`agentgit-openai-agents`, `agentgit-autogen`, `agentgit-crewai`)
so that `pip install -e adapters/<name>` in a clean venv pulls the shared
`agentgit_adapter` package instead of relying on the monorepo conftest sys.path
hack. Each adapter's README now also shows a one-line `pip install` example,
matching the documentation pattern users will follow once the packages are
published.

## Files changed
- `adapters/openai-agents/pyproject.toml` — `dependencies = ["agentgit-adapter>=0.1.0"]`
- `adapters/autogen/pyproject.toml` — same
- `adapters/crewai/pyproject.toml` — same
- `adapters/openai-agents/README.md` — added `pip install agentgit-openai-agents` block
- `adapters/autogen/README.md` — added `pip install agentgit-autogen` block
- `adapters/crewai/README.md` — added `pip install agentgit-crewai` block

No adapter code (`adapter.py`) was touched; the in-repo sys.path bootstrap stays
in place for monorepo development convenience and is now a no-op when the
package is properly installed.

## Verification
Ran in a fresh `python3 -m venv`:

```
pip install -e adapters/python[dev] -e adapters/openai-agents[dev] \
            -e adapters/autogen[dev] -e adapters/crewai[dev]
pytest adapters/openai-agents adapters/autogen adapters/crewai -q
# => 3 passed in 0.24s
```

Direct imports from a clean venv:

```
from agentgit_openai_agents import wrap_agent  # ok
from agentgit_autogen import wrap_agent        # ok
from agentgit_crewai import wrap_crew          # ok
```

Note: `pip install -e adapters/openai-agents` in isolation (without also
installing `adapters/python` or pre-installing `agentgit-adapter`) still fails
because `agentgit-adapter` is not yet on PyPI; that is a publication concern
outside this ticket's scope. The dependency declaration is correct and pip
correctly attempts to resolve it.

## APIs / interfaces other tickets may consume
None. Public Python APIs (`wrap_agent`, `wrap_crew`) are unchanged.
Downstream consumers (e.g. a CI matrix that installs adapters individually) can
now rely on transitive resolution of `agentgit-adapter` instead of having to
install it explicitly first — though until `agentgit-adapter` is published, the
local `-e adapters/python` install must still happen in the same `pip install`
invocation.
