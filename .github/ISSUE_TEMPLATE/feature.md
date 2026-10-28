name: Feature idea
description: Propose a new capability or improvement
title: ""
labels: ["enhancement", "triage"]
body:
  - type: textarea
    id: what
    attributes:
      label: What do you want to happen?
      description: The capability, and the problem it solves.
    validations:
      required: true
  - type: textarea
    id: why
    attributes:
      label: Why is this worth it?
      description: How often would it be used, and what it would replace.
    validations:
      required: false
  - type: textarea
    id: alt
    attributes:
      label: Anything you've tried
      description: Related workarounds or prior approaches you've considered.
    validations:
      required: false
