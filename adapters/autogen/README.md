# agentgit-autogen

AgentGit adapter for [AutoGen](https://microsoft.github.io/autogen/).

```bash
pip install agentgit-autogen
```

```python
from agentgit_autogen import wrap_agent
wrap_agent(my_conversable_agent, ".agentgit-repo")
```

Each `execute_function` call (tool dispatch) and each inbound message
(`_process_received_message`) is recorded as a commit in the AgentGit
repository.
