# Add New Python Adapters to CI Matrix

## Goal
Ensure the three new Python adapters (openai-agents, autogen, crewai) are installed and tested in the CI "Python adapters" job so that regressions in these adapters are caught before merge, matching the coverage already provided for adapters/python and adapters/langchain.

## Context
The CI workflow at `.github/workflows/ci.yml` defines a "python" job (lines 82-100) that runs on matrix python versions 3.10/3.11/3.12. The "Install adapters" step only does `pip install -e adapters/python[dev]` and `pip install -e adapters/langchain[dev]`, and the "Run pytest" step only runs `pytest adapters/python adapters/langchain`. The adapters/openai-agents, adapters/autogen, and adapters/crewai packages each have their own pyproject.toml with `[project.optional-dependencies] dev = ["pytest>=8.0"]` and a tests/ directory with smoke tests (test_openai_agents_smoke.py, test_autogen_smoke.py, test_crewai_smoke.py), but they are never installed or executed in CI. Each adapter depends on `agentgit-adapter>=0.1.0` (the base python adapter), so they can be installed after the base adapter.

The adapters are fully implemented (adapter.py, __init__.py, tests) and pass when run locally with `python -m pytest adapters/openai-agents adapters/autogen adapters/crewai`. The docs/adapters.md documents the Python and LangChain adapters but does not yet document the three new SDK-specific adapters.

## Technical Approach
1. In `.github/workflows/ci.yml`, extend the "Install adapters" step under the python job to also install the three new adapters in dev mode:
   - `pip install -e adapters/openai-agents[dev]`
   - `pip install -e adapters/autogen[dev]`
   - `pip install -e adapters/crewai[dev]`
2. Extend the "Run pytest" step to include the three new adapter directories:
   - `pytest adapters/python adapters/langchain adapters/openai-agents adapters/autogen adapters/crewai`
3. No changes to adapter code or pyproject.toml files are required; the existing dev extras and test entry points are sufficient.
4. Optionally update docs/adapters.md to document the new adapters (out of scope for this minimal CI fix; see separate docs ticket if needed).

The change is isolated to the CI workflow file and follows the existing pattern exactly.

## Acceptance Criteria
- [ ] The CI "Python ${{ matrix.python }} adapters" job installs all five Python adapter packages without error.
- [ ] The pytest invocation in CI runs tests for all five adapter directories and reports results for each.
- [ ] All existing Python adapter tests (95+ tests) continue to pass in CI.
- [ ] A developer can verify locally with the same pip install + pytest commands used in CI.

## Files to Touch
- .github/workflows/ci.yml (modify | extend Install adapters and Run pytest steps in the python job)

## Test Strategy
To verify locally (matches what CI will do):

```bash
python -m pip install --upgrade pip
pip install -e adapters/python[dev]
pip install -e adapters/langchain[dev]
pip install -e adapters/openai-agents[dev]
pip install -e adapters/autogen[dev]
pip install -e adapters/crewai[dev]
python -m pytest adapters/python adapters/langchain adapters/openai-agents adapters/autogen adapters/crewai -q
```

In CI, the matrix job will exercise this on Python 3.10, 3.11, and 3.12. The change can be validated by pushing a branch and observing the "Python 3.x adapters" job in the GitHub Actions UI, or by running act locally if available.
