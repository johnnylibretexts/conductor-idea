/** Test-process-only JWT configuration; imported before app modules capture env. */
process.env.SECRETKEY = 'idea-tests-only-not-a-deployment-secret';
process.env.PRODUCTIONURLS = 'https://idea.example.test';
