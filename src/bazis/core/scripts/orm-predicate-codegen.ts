import path from "node:path";
import ts from "typescript";

/** Reject JS truthiness where the caller is constructing an ORM condition. */
export function analyzeOrmPredicates(checker: ts.TypeChecker, source: ts.SourceFile): readonly string[] {
  const diagnostics: string[] = [];
  const isPredicate = (type: ts.Type): boolean => {
    if (type.isUnionOrIntersection()) return type.types.some(isPredicate);
    const symbol = type.getSymbol();
    return symbol?.name === "Predicate" && (symbol.declarations ?? []).some(declaration =>
      declaration.getSourceFile().fileName.replaceAll("\\", "/").endsWith("/library/orm/Query/conditions.ts"));
  };
  const reject = (node: ts.Node): void => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    // Relative like the other codegen diagnostics: the project path is noise.
    const fileName = (path.isAbsolute(source.fileName) ? path.relative(".", source.fileName) : source.fileName).replaceAll("\\", "/");
    diagnostics.push(`BAZIS_ORM_PREDICATE_LOGIC: ${fileName}:${location.line + 1}:${location.character + 1}: `
      + "ORM conditions cannot use JavaScript truthiness: JavaScript keeps only one side of && and ||. "
      + "Use .and(), .or(), .not(): (p) => p.views.gt(70).and(p.authorId.eq(2)).");
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      && (isPredicate(checker.getTypeAtLocation(node.left)) || isPredicate(checker.getTypeAtLocation(node.right)))) {
      reject(node);
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken
      && isPredicate(checker.getTypeAtLocation(node.operand))) {
      reject(node);
    } else if ((ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isWhileStatement(node) || ts.isDoStatement(node))
      && isPredicate(checker.getTypeAtLocation(ts.isConditionalExpression(node) ? node.condition : node.expression))) {
      reject(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}
