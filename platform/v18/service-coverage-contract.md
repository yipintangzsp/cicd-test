# V18 service coverage contract

V18 makes a precise distinction: **coverage** means every Kubernetes resource
captured from Pods, Services, Endpoints, EndpointSlices, workloads, CronJobs,
Jobs, Ingresses, and data custom resources has a service-inventory record.
It does not mean every service is healthy.

The Jenkins quality gate requires all of the following:

1. Live Kubernetes capture succeeds for the mandatory resource types.
2. Resource coverage is exactly 100%.
3. All 45 known platform software entries have a declared usage path.
4. Kafka, Flink, Spark, Airflow, MinIO, Trino, Superset, relational metadata,
   and Redis each appear in the Big Data coverage model.
5. V18 contains at least 1,150 audited stages.
6. The V18 isolation audit passes: V18 declares only V18-owned parameters and
   its runtime source does not load a router, another pipeline, or another
   version's artifacts.

The generated SVG diagrams are vector assets: they remain legible when zoomed,
and their labels always distinguish runtime observation from mapped intent.
