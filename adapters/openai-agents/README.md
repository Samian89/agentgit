# agentgit-openai-agents

AgentGit adapter for the OpenAI Agents SDK.

```bash
pip install agentgit-openai-agents
```

```python
from agentgit_openai_agents import wrap_agent
agent = wrap_agent(my_openai_agent, ".agentgit-repo")
```

Each `run_step` call on the wrapped agent is recorded as a commit in the
AgentGit repository at the configured path.
