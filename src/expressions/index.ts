import data from "./expressions.json";

export interface ExpressionFunction {
	name: string;
	syntax: string;
	description: string;
}

export interface ExpressionConstant {
	name: string;
	description: string;
}

export interface ExpressionScope {
	name: string;
	description: string;
}

export interface ObjectModelNamespace {
	name: string;
	description: string;
}

export interface ExpressionData {
	functions: ExpressionFunction[];
	constants: ExpressionConstant[];
	scopes: ExpressionScope[];
	objectModel: ObjectModelNamespace[];
}

export const expressionData: ExpressionData = data as ExpressionData;