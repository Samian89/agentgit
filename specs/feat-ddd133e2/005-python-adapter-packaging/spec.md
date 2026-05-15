# Python Adapter Packaging — Declare Runtime Dependency on agentgit-adapter

## Goal
Make the three new Python adapters (`agentgit-openai-agents`, `agentgit-autogen`, `agentgit-crewai`) independently pip-installable so that "expanded adapter coverage" advertised in the README and built list is actually consumable by users who are not inside the AgentGit monorepo checkout.

## Context
All three new adapters (`adapters/{openai-agents,autogen,crewai}/agentgit_*/adapter.py`) contain the identical pattern:

```python
_PY_ADAPTER = os.path.abspath(os.path.join(_THIS, "..", "..", "python"))
if _PY_ADAPTER not in sys.path:
    sys.path.insert(0, _PY_ADAPTER)
from agentgit_adapter import AgentWrapper
```

Their `pyproject.toml` files declare `dependencies = []` and only `[project.optional-dependencies] dev = ["pytest"]`. In contrast, `adapters/langchain/pyproject.toml` correctly lists `dependencies = ["agentgit-adapter>=0.1.0", "langchain-core>=0.2.0"]`. The subagent that read every pyproject.toml + adapter.py + conftest.py confirmed the inconsistency. Consequently `pip install agentgit-openai-agents` (once published) would fail with `ModuleNotFoundError: agentgit_adapter`. The smoke tests only pass today because the monorepo pytest invocation adds both roots to sys.path via conftest.py before collection.

## Technical Approach
For each of the three adapters, edit its `pyproject.toml`:

1. Add the runtime dependency:
   ```toml
   dependencies = ["agentgit-adapter>=0.1.0"]
   ```
2. (Optional but recommended) also add the framework dependency the adapter actually imports at runtime (e.g. for openai-agents: the upstream `openai-agents` package or a version pin if the stub is replaced). Keep the current stub-based smoke tests; they do not import the real SDK.
3. Update the adapter's README.md (one-line install example) to match the langchain pattern.
4. No code change in adapter.py — the sys.path hack can stay for monorepo development convenience; pip will now satisfy the import via the declared dependency.

After the change, `pip install -e adapters/openai-agents` inside the monorepo will pull the sibling (or the already-installed) agentgit-adapter and the smoke test continues to work.

## Acceptance Criteria
- [ ] `pip install -e adapters/openai-agents` (and the autogen/crewai equivalents) succeeds without manual PYTHONPATH manipulation.
- [ ] After install, `python -c "from agentgit_openai_agents import wrap_agent; print('ok')"` succeeds.
- [ ] The existing `test_openai_agents_smoke.py` (and siblings) still pass when run from a clean virtualenv that only has the adapter + its declared deps.
- [ ] `pyproject.toml` for the three packages now matches the structure of `adapters/langchain/pyproject.toml` for the `dependencies` key.

## Files to Touch
- adapters/openai-agents/pyproject.toml (modify | add runtime dependency)
- adapters/autogen/pyproject.toml (modify | add runtime dependency)
- adapters/crewai/pyproject.toml (modify | add runtime dependency)
- adapters/openai-agents/README.md (modify | add one-line pip install example)
- adapters/autogen/README.md (modify | same)
- adapters/crewai/README.md (modify | same)
- adapters/langchain/pyproject.toml (read-only | canonical example of correct dependency declaration)
- adapters/openai-agents/tests/conftest.py (read-only | explains why sys.path hack existed)

## Test Strategy
The verification command (exactly the one the user query asks to run):

```bash
python -m pip install --upgrade pip
pip install -e adapters/python[dev]
pip install -e adapters/openai-agents[dev]   # must succeed and pull agentgit-adapter
pip install -e adapters/autogen[dev]
pip install -e adapters/crewai[dev]
python -m pytest adapters/openai-agents adapters/autogen adapters/crewai -q --tb=no
```

Run the same sequence in a fresh virtualenv (no prior sys.path edits) to prove standalone installability. This change is a one-line edit per file and can be done by one engineer in a single session; it unblocks the CI matrix expansion in 002.