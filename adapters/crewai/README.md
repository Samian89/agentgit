# agentgit-crewai

AgentGit adapter for [CrewAI](https://www.crewai.com/).

```python
from agentgit_crewai import wrap_crew
wrap_crew(my_crew, ".agentgit-repo")
```

`Crew.kickoff` and each `Task.execute` call become commits in the AgentGit
repository.
