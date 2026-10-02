/**
 * Redirects an old URL to where its page lives now, keeping the old query
 * string and hash (OAuth flags like `?upgraded=true` must survive).
 *
 * @module components/Routing/LegacyRedirect
 */
import React from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { mergeRedirectTarget, type LegacyRedirect as LegacyRedirectRule } from '../../constants/routes.constants';

/**
 * `<Navigate replace>` to the rule's target.
 *
 * @param props.rule - The redirect rule for this route
 * @returns Navigate element
 */
export const LegacyRedirect: React.FC<{ rule: LegacyRedirectRule }> = ({ rule }) => {
	const params = useParams();
	const { search, hash } = useLocation();
	return <Navigate to={mergeRedirectTarget(rule.to(params), search, hash)} replace />;
};

export default LegacyRedirect;
