# Acceptance queries

Run from the repository root against `collapse-state-design`.

```bash
vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-design | where status=todo,blocked | select id label form owner stage'

vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-design | where id=p1 | follow motivates | follow* decomposes_into | paths | select id label path'

vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-design | where id=m1 | follow* decomposes_into | paths | select id label summary path'

vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-design | where id=m2 | follow produces | follow decomposes_into | paths | select id label path'

vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-design | where id=ds1,ape1,rvm1,ued1,va1 | select id label form status stage summary'
```

## Execution context

```bash
vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-execution | where id=ap1,ep1 | select id label form status stage source revision check'

vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'nodes at collapse-state-execution | where id=ap1 | follow implemented_by | paths | select id label form path'

vyasa kg-query .daksh/knowledge-graph.kg/kg.schema \
  'diff collapse-state-design collapse-state-execution'
```
