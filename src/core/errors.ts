export class KairosError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KairosError'
  }
}

export class BusinessRuleError extends KairosError {
  constructor(message: string) {
    super(message)
    this.name = 'BusinessRuleError'
  }
}

export class DCBConflictError extends KairosError {
  constructor(message = 'Append failed: conflicting events since read') {
    super(message)
    this.name = 'DCBConflictError'
  }
}

export class ValidationError extends KairosError {
  constructor(message: string, public readonly issues: unknown) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class NotImplementedError extends KairosError {
  constructor(what: string) {
    super(`Not implemented: ${what}`)
    this.name = 'NotImplementedError'
  }
}
